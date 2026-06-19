#!/usr/bin/env node
import { Command } from "commander";
import { basename, extname, join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { transcribe, type ProgressEvent } from "./pipeline.js";

const program = new Command();

program
  .name("offmute-v2")
  .description("Timestamp-correct, diarized meeting transcription (multimodal LLM + ASR)")
  .argument("<input>", "audio or video file")
  .option("-i, --instructions <text>", "instructions to guide diarization/speaker labeling")
  .option("-m, --model <model>", "LLM model", "gemini-flash-latest")
  .option("--asr <provider>", "ASR provider for timing: assemblyai | none", "assemblyai")
  .option("--asr-model <model>", "ASR speech model (provider-specific)")
  .option("--no-video", "ignore video (audio only)")
  .option("--keyframes <n>", "number of keyframes for video context", "8")
  .option("--no-sub-segment", "keep whole speaker turns (don't split into display cues)")
  .option("--no-identify", "skip the speaker-identification/merge pass")
  .option("--thinking-level <level>", "LLM thinking level: MINIMAL|LOW|MEDIUM|HIGH", "MINIMAL")
  .option("-o, --out <dir>", "output directory for transcript files", ".")
  .option("--intermediates-dir <dir>", "directory for intermediate artifacts")
  .option("--no-cache", "ignore cached intermediates")
  .option("-f, --format <fmt>", "output format: srt | md | json | text | all", "all")
  .action(async (input: string, opts) => {
    const start = Date.now();
    const base = basename(input, extname(input));
    const outDir = resolve(opts.out);
    // Fail fast on a bad output dir, and create it so we don't crash AFTER all the
    // expensive work. Keep intermediates WITH the output (not next to the input).
    try {
      mkdirSync(outDir, { recursive: true });
    } catch (e) {
      console.error(`✗ Cannot create output directory ${outDir}: ${(e as Error).message}`);
      process.exit(1);
    }
    const intermediatesDir = opts.intermediatesDir ? resolve(opts.intermediatesDir) : join(outDir, `.offmute_${base}`);

    // Live, updating elapsed-time line per stage (so long stages don't look frozen).
    let stage = "";
    let msg = "";
    const elapsed = () => ((Date.now() - start) / 1000).toFixed(0);
    const render = () => process.stderr.write(`\r[${elapsed()}s] ${stage}: ${msg}[K`);
    const onProgress = (e: ProgressEvent) => {
      if (e.stage !== stage) {
        if (stage) process.stderr.write("\n");
        stage = e.stage;
        msg = e.message;
      } else {
        msg = msg ? `${msg} · ${e.message}` : e.message;
      }
      render();
    };
    const ticker = setInterval(render, 1000);

    try {
      const result = await transcribe(resolve(input), {
        instructions: opts.instructions,
        llmModel: opts.model,
        asr: opts.asr,
        asrModel: opts.asrModel,
        useVideo: opts.video,
        keyframeCount: parseInt(opts.keyframes, 10),
        subSegment: opts.subSegment,
        identifySpeakers: opts.identify,
        llmThinkingLevel: opts.thinkingLevel,
        intermediatesDir,
        cache: opts.cache,
        onProgress,
      });
      clearInterval(ticker);

      const want = (f: string) => opts.format === "all" || opts.format === f;
      const written: string[] = [];
      if (want("srt")) {
        const p = join(outDir, `${base}.srt`);
        writeFileSync(p, result.srt);
        written.push(p);
      }
      if (want("md")) {
        const p = join(outDir, `${base}.md`);
        writeFileSync(p, result.markdown);
        written.push(p);
      }
      if (want("json")) {
        const p = join(outDir, `${base}.json`);
        writeFileSync(p, result.json);
        written.push(p);
      }
      if (want("text")) {
        const p = join(outDir, `${base}.txt`);
        writeFileSync(p, result.text);
        written.push(p);
      }

      process.stderr.write("\n\n");
      const { transcript } = result;
      console.log(`✓ ${transcript.segments.length} segments · ${transcript.speakers.length} speakers · ${(((Date.now() - start) / 1000) | 0)}s`);
      console.log(`  Speakers: ${transcript.speakers.map((s) => s.label).join(", ")}`);
      for (const p of written) console.log(`  → ${p}`);
      console.log(`  Intermediates: ${result.intermediatesDir}`);
    } catch (err) {
      clearInterval(ticker);
      process.stderr.write("\n");
      console.error(`✗ ${(err as Error).message}`);
      process.exit(1);
    }
  });

program.parseAsync();
