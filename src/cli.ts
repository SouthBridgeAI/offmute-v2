#!/usr/bin/env node
/**
 * offmute-v2 CLI entry point.
 */
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { transcribe } from "./core/pipeline.js";
import type { Pass } from "./core/config.js";

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
  .description("Diarized meeting transcription with multimodal LLMs + timestamped alignment.")
  .version(packageVersion)
  .argument("<input>", "input video/audio file")
  .option("-o, --output <dir>", "output directory", "./output")
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
  .option("--formats <list>", "output formats: srt,md,json", "srt,md,json")
  .option("--level <1|2|3>", "diarization level (1=separation, 2=consistent, 3=identify)", "2")
  .option("--model <name>", "override transcription model")
  .option("--reasoner <name>", "override text-reasoner model (default deepseek-chat)")
  .option("--timestamped <provider>", "timestamped provider (assemblyai|whisper-groq|none)")
  .option("--force", "force reprocess cached chunk outputs", false)
  .option("--only-chunk <n>", "process only a specific chunk index (debug)")
  .option("--save-intermediates", "save intermediates (default true)", true)
  .option("--no-progress", "hide progress output")
  .option("--no-llm-log", "disable per-call LLM logging to <intermediates>/llm-calls.jsonl")
  .option("--log-level <level>", "debug | info | warn | error", "info");

program.parse();
const opts = program.opts();

const input = program.args[0];
if (!input) {
  console.error("Error: input file is required.");
  process.exit(1);
}

const passes = (opts.passes as string | undefined)?.split(",") as Pass[] | undefined;
const level = parseInt(opts.level, 10) as 1 | 2 | 3;

transcribe({
  input,
  outputDir: opts.output,
  intermediatesDir: opts.intermediates,
  instructions: opts.instructions,
  passes,
  chunkDurationSec: parseInt(opts.chunkSeconds, 10),
  chunkOverlapSec: parseInt(opts.overlapSeconds, 10),
  concurrency: parseInt(opts.concurrency, 10),
  screenshotCount: parseInt(opts.screenshots, 10),
  formats: opts.formats.split(","),
  diarizationLevel: level,
  model: opts.model,
  reasoner: opts.reasoner,
  timestampedProvider: opts.timestamped,
  force: opts.force,
  onlyChunk: opts.onlyChunk ? parseInt(opts.onlyChunk, 10) : undefined,
  saveIntermediates: opts.saveIntermediates,
  showProgress: opts.progress,
  llmLog: opts.llmLog,
  logLevel: opts.logLevel,
})
  .then((result) => {
    // Result-writing is handled inside finalize in the real pipeline.
    const segs = result.segments.length;
    console.log(`Done. ${segs} segments.`);
  })
  .catch((err) => {
    // Print a clean, single-line message for expected errors (missing keys/ffmpeg/input,
    // bad model, network). The full stack is only shown in debug mode (or OFFMUTE_DEBUG).
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n✗ ${msg}`);
    if (opts.logLevel === "debug" || process.env.OFFMUTE_DEBUG) {
      console.error(err instanceof Error ? err.stack : err);
    }
    process.exit(1);
  });
