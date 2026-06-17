/**
 * Test H3: align the 5-min LLM chunk to the ASR words; report confidence + timing
 * refinement, and spot-check against the reference SRT.
 * Usage: npx tsx scripts/align-test.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { alignSegments } from "../src/align/aligner.js";
import { parseSrt } from "../src/utils/srt.js";
import { secondsToTimestamp } from "../src/utils/time.js";
import type { ParsedLlmSegment } from "../src/transcribe/llm-transcribe.js";
import type { TimestampedWord } from "../src/core/types.js";

async function main() {
  const llmPath = resolve("./intermediates/llm-test/chunk_000_parsed.json");
  const asrPath = resolve("./intermediates/timestamped-test/timestamped.json");
  const refPath = resolve("../test-files/1/talk-with-questions.srt");

  const llm = JSON.parse(readFileSync(llmPath, "utf-8")) as { segments: ParsedLlmSegment[] };
  const asr = JSON.parse(readFileSync(asrPath, "utf-8")) as { words: TimestampedWord[] };
  const ref = parseSrt(readFileSync(refPath, "utf-8"));

  const llmSegs = llm.segments;
  // Only align the first 5 min (the chunk we transcribed).
  const asrWords = asr.words.filter((w) => w.start < 305);

  console.log(`LLM segments: ${llmSegs.length}, ASR words (0-305s): ${asrWords.length}`);
  const aligned = alignSegments(llmSegs, asrWords);

  // Stats
  const bySource = { aligned: 0, interpolated: 0, coarse: 0 };
  let confSum = 0;
  for (const a of aligned) {
    bySource[a.timingSource]++;
    confSum += a.confidence;
  }
  console.log("\n=== ALIGNMENT STATS ===");
  console.log("timing source:", bySource);
  console.log(
    `avg confidence: ${(confSum / aligned.length).toFixed(2)}, median: ${median(aligned.map((a) => a.confidence)).toFixed(2)}`,
  );

  // Timing refinement: |aligned.start - coarse.start|
  const deltas = aligned.map((a) => Math.abs(a.start - llmSegs[a.sourceIndex]!.startSec));
  console.log(
    `coarse→aligned start delta: median ${median(deltas).toFixed(2)}s, max ${Math.max(...deltas).toFixed(2)}s`,
  );

  console.log("\n=== FIRST 10 ALIGNED SEGMENTS (coarse → aligned) ===");
  for (const a of aligned.slice(0, 10)) {
    const coarse = llmSegs[a.sourceIndex]!;
    console.log(
      `[${secondsToTimestamp(coarse.startSec)}→${secondsToTimestamp(a.start)}] conf ${a.confidence.toFixed(2)} ${a.speaker}: ${a.text.slice(0, 70)}`,
    );
  }

  // Spot-check against reference: for each aligned segment, find the reference entry
  // with the closest start time and report the gap.
  const refFirst5 = ref.filter((r) => r.start < 305);
  const gaps: number[] = [];
  for (const a of aligned) {
    let best = Infinity;
    for (const r of refFirst5) {
      const d = Math.abs(r.start - a.start);
      if (d < best) best = d;
    }
    gaps.push(best);
  }
  console.log(
    `\n=== vs REFERENCE SRT (first 5min, ${refFirst5.length} ref entries) ===`,
  );
  console.log(
    `nearest-ref start gap: median ${median(gaps).toFixed(2)}s, p90 ${percentile(gaps, 0.9).toFixed(2)}s, max ${Math.max(...gaps).toFixed(2)}s`,
  );

  mkdirSync(resolve("./intermediates/align-test"), { recursive: true });
  writeFileSync(
    resolve("./intermediates/align-test/aligned.json"),
    JSON.stringify({ aligned, stats: bySource }, null, 2),
  );
  console.log("\nsaved ./intermediates/align-test/aligned.json");
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  return percentile(xs, 0.5);
}
function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor(p * s.length));
  return s[idx]!;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
