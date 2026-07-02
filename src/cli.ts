#!/usr/bin/env node
/**
 * offmute-v2 CLI entry point.
 *
 * `offmute-v2 <input> [options]` transcribes (default command); subcommands:
 *   models — the model matrix and what your keys unlock
 *   doctor — environment + key + API health check
 */
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { transcribe } from "./core/pipeline.js";
import type { Pass } from "./core/config.js";
import { runModels } from "./commands/models.js";
import { runDoctor } from "./commands/doctor.js";
import { runStats } from "./commands/stats.js";
import { runRename } from "./commands/rename.js";
import { runWatch } from "./commands/watch.js";
import { notify } from "./utils/notify.js";
import { basename } from "node:path";

let packageVersion = "0.0.0";
try {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf-8"));
  packageVersion = pkg.version;
} catch {
  // ignore — dev mode
}

const program = new Command();

program
  .name("offmute-v2")
  .description(
    "Diarized meeting transcription with multimodal LLMs + timestamped alignment.",
  )
  .version(packageVersion);

interface TranscribeCliOpts {
  output?: string;
  intermediates?: string;
  instructions?: string;
  passes?: string;
  chunkSeconds: string;
  overlapSeconds: string;
  concurrency: string;
  screenshots: string;
  formats?: string;
  mdStyle?: "merged" | "turns";
  summary: boolean;
  speakers?: string;
  level: string;
  identify?: "dual" | "single";
  model?: string;
  reasoner?: string;
  timestamped?: "assemblyai" | "elevenlabs" | "whisper-groq" | "none";
  force: boolean;
  onlyChunk?: string;
  saveIntermediates: boolean;
  progress: boolean;
  llmLog: boolean;
  logLevel: string;
  notify: boolean;
}

async function runTranscribe(input: string, opts: TranscribeCliOpts): Promise<void> {
  const passes = opts.passes?.split(",") as Pass[] | undefined;
  let level = parseInt(opts.level, 10) as 1 | 2 | 3;
  // Providing known speakers means the user wants names — implies the identify pass.
  if (opts.speakers && level < 3) level = 3;

  const t0 = Date.now();
  const result = await transcribe({
    input,
    outputDir: opts.output, // undefined → defaults to the input file's directory
    intermediatesDir: opts.intermediates,
    instructions: opts.instructions,
    passes,
    chunkDurationSec: parseInt(opts.chunkSeconds, 10),
    chunkOverlapSec: parseInt(opts.overlapSeconds, 10),
    concurrency: parseInt(opts.concurrency, 10),
    screenshotCount: parseInt(opts.screenshots, 10),
    formats: opts.formats
      ? (opts.formats.split(",") as ("srt" | "md" | "json" | "txt" | "html")[])
      : undefined, // undefined → defaults to ["md"]
    mdStyle: opts.mdStyle,
    summary: opts.summary,
    knownSpeakers: opts.speakers
      ? opts.speakers
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    diarizationLevel: level,
    identifyMode: opts.identify,
    model: opts.model,
    reasoner: opts.reasoner,
    timestampedProvider: opts.timestamped,
    force: opts.force,
    onlyChunk: opts.onlyChunk ? parseInt(opts.onlyChunk, 10) : undefined,
    saveIntermediates: opts.saveIntermediates,
    showProgress: opts.progress,
    llmLog: opts.llmLog,
    logLevel: opts.logLevel as "debug" | "info" | "warn" | "error",
  });
  console.log(`Done. ${result.segments.length} segments.`);
  // A run long enough to walk away from earns a ping when it's back.
  if (opts.notify && Date.now() - t0 > 120_000) {
    const cost = result.metadata.cost
      ? ` · ~$${result.metadata.cost.actualUsd.toFixed(2)}`
      : "";
    notify(
      "offmute-v2",
      `${basename(input)} transcribed — ${result.segments.length} segments${cost}`,
    );
  }
}

function addTranscribeOptions(cmd: Command): Command {
  return cmd
    .option("-o, --output <dir>", "output directory (default: next to the input file)")
    .option(
      "-i, --intermediates <dir>",
      "intermediates directory (default: auto-derived per input file so caches never collide)",
    )
    .option("--instructions <text>", "custom instructions for the LLM")
    .option("--passes <list>", "comma-separated passes to run")
    .option("--chunk-seconds <n>", "chunk duration in seconds", "600")
    .option("--overlap-seconds <n>", "chunk overlap in seconds", "60")
    .option("--concurrency <n>", "max concurrent chunk requests", "4")
    .option("--screenshots <n>", "number of keyframes to extract (video)", "6")
    .option("--formats <list>", "output formats: srt,md,txt,html,json (default: md)")
    .option(
      "--md-style <style>",
      "markdown layout: merged (paragraphs) | turns",
      "merged",
    )
    .option(
      "--summary",
      "also write <name>.summary.md (TL;DR, decisions, action items)",
      false,
    )
    .option(
      "--speakers <names>",
      "known speaker names, comma-separated (implies --level 3)",
    )
    .option(
      "--level <1|2|3>",
      "diarization level (1=separation, 2=anonymous consistent, 3=verified names)",
      "3",
    )
    .option(
      "--identify <mode>",
      "speaker naming: dual (two reasoners, default) | single",
      "dual",
    )
    .option("--model <name>", "override transcription model")
    .option("--reasoner <name>", "override text-reasoner model (default deepseek-chat)")
    .option(
      "--timestamped <provider>",
      "timestamped provider (assemblyai|elevenlabs|whisper-groq|none)",
    )
    .option("--force", "force reprocess cached chunk outputs", false)
    .option("--only-chunk <n>", "process only a specific chunk index (debug)")
    .option("--save-intermediates", "save intermediates (default true)", true)
    .option("--no-progress", "hide progress output")
    .option(
      "--no-llm-log",
      "disable per-call LLM logging to <intermediates>/llm-calls.jsonl",
    )
    .option("--no-notify", "skip the OS notification after long runs")
    .option("--log-level <level>", "debug | info | warn | error", "info");
}

addTranscribeOptions(
  program
    .command("transcribe <input>", { isDefault: true })
    .description("transcribe a video/audio file (default command)"),
).action(async (input: string, opts: TranscribeCliOpts) => {
  try {
    await runTranscribe(input, opts);
  } catch (err) {
    // Print a clean, single-line message for expected errors (missing keys/ffmpeg/input,
    // bad model, network). The full stack is only shown in debug mode (or OFFMUTE_DEBUG).
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n✗ ${msg}`);
    if (opts.logLevel === "debug" || process.env.OFFMUTE_DEBUG) {
      console.error(err instanceof Error ? err.stack : err);
    }
    process.exit(1);
  }
});

program
  .command("models")
  .description("list model presets per role and what your keys unlock")
  .action(runModels);

program
  .command("doctor")
  .description("check ffmpeg, API keys, and provider reachability")
  .action(runDoctor);

program
  .command("stats")
  .description("lifetime stats: hours processed, characters, cost by model")
  .action(runStats);

program
  .command("watch <dir>")
  .description("daemon mode: watch a folder, transcribe media files as they appear")
  .option("--match <exts>", "comma-separated extensions to watch (default: common media)")
  .option("--jobs <n>", "max concurrent transcription jobs", "1")
  .option("--no-backlog", "skip files already in the folder at startup")
  .option("-o, --output <dir>", "write transcripts here (default: next to each input)")
  .option("--formats <list>", "output formats: srt,md,txt,html,json (default: md)")
  .option("--md-style <style>", "markdown layout: merged | turns", "merged")
  .option("--summary", "also write a summary per file", false)
  .option("--instructions <text>", "custom instructions for the LLM")
  .option(
    "--speakers <names>",
    "known speaker names, comma-separated (implies --level 3)",
  )
  .option("--level <1|2|3>", "diarization level", "3")
  .option("--identify <mode>", "speaker naming: dual | single", "dual")
  .option("--model <name>", "override transcription model")
  .option("--reasoner <name>", "override text-reasoner model")
  .option("--timestamped <provider>", "assemblyai|elevenlabs|whisper-groq|none")
  .action(
    async (
      dir: string,
      opts: {
        match?: string;
        jobs: string;
        backlog: boolean;
        output?: string;
        formats?: string;
        mdStyle?: "merged" | "turns";
        summary: boolean;
        instructions?: string;
        speakers?: string;
        level: string;
        identify?: "dual" | "single";
        model?: string;
        reasoner?: string;
        timestamped?: "assemblyai" | "elevenlabs" | "whisper-groq" | "none";
      },
    ) => {
      let level = parseInt(opts.level, 10) as 1 | 2 | 3;
      if (opts.speakers && level < 3) level = 3;
      await runWatch(dir, {
        match: opts.match,
        jobs: opts.jobs,
        backlog: opts.backlog,
        output: opts.output,
        pipeline: {
          formats: opts.formats
            ? (opts.formats.split(",") as ("srt" | "md" | "json" | "txt" | "html")[])
            : undefined,
          mdStyle: opts.mdStyle,
          summary: opts.summary,
          instructions: opts.instructions,
          knownSpeakers: opts.speakers
            ? opts.speakers
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined,
          diarizationLevel: level,
          identifyMode: opts.identify,
          model: opts.model,
          reasoner: opts.reasoner,
          timestampedProvider: opts.timestamped,
        },
      });
    },
  );

program
  .command("rename <result-json> <mappings...>")
  .description(
    'retcon speaker names without reprocessing, e.g. rename out.json "Speaker B=Ang Li"',
  )
  .option("--formats <list>", "formats to regenerate next to the json", "md,srt,txt")
  .option("--md-style <style>", "markdown layout: merged | turns", "merged")
  .action(
    (
      jsonPath: string,
      mappings: string[],
      opts: { formats: string; mdStyle?: "merged" | "turns" },
    ) => {
      runRename(jsonPath, mappings, opts);
    },
  );

program.parse();
