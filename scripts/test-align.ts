/**
 * Validate the alignment layer: align Gemini diarized turns to AssemblyAI words,
 * recover precise timings, compare to ground-truth SRT.
 * Run: bun run scripts/test-align.ts [clip] [model]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDiarizedText } from "../src/core/parse-diarized.js";
import { assignTimings, interpolateTimings, normalizeToken, tokenize } from "../src/core/align.js";
import { secondsToCompact } from "../src/core/time.js";
import { parseSrt } from "../src/core/srt.js";
import type { AsrResult } from "../src/types.js";

const clip = process.argv[2] ?? "talk-clip-0-180";
const model = process.argv[3] ?? "gemini-flash-latest";
const root = join(import.meta.dir, "../..");

const geminiTxt = readFileSync(join(root, `intermediates/gemini/${clip}.${model}.txt`), "utf8");
const asr = JSON.parse(readFileSync(join(root, `intermediates/asr/${clip}.asr.json`), "utf8")) as AsrResult;

// clip offset within full media (for comparing to ground-truth absolute times)
const clipOffset = clip.includes("720-960") ? 720 : 0;

const turns = parseDiarizedText(geminiTxt);
console.log(`Parsed ${turns.length} LLM turns; ASR has ${asr.words.length} words.\n`);

const segments = turns.map((t, i) => ({
  segmentId: i,
  tokens: tokenize(t.text).map(normalizeToken).filter(Boolean),
}));

const t0 = performance.now();
const timed = assignTimings(segments, asr.words);
interpolateTimings(timed, asr.durationSeconds);
console.log(`Aligned in ${(performance.now() - t0).toFixed(0)}ms\n`);

// ground truth
const gt = parseSrt(readFileSync(join(root, "test-files/1/talk-with-questions.srt"), "utf8"));

console.log("=== Aligned turns (start→end | llm mm:ss | matchRatio) ===");
for (let i = 0; i < turns.length; i++) {
  const t = turns[i]!;
  const r = timed[i]!;
  const absStart = (r.start ?? 0) + clipOffset;
  const absEnd = (r.end ?? 0) + clipOffset;
  const snippet = t.text.length > 70 ? t.text.slice(0, 70) + "…" : t.text;
  console.log(
    `[${secondsToCompact(absStart)}→${secondsToCompact(absEnd)}] ` +
      `llm=${t.approxStart !== undefined ? secondsToCompact(t.approxStart + clipOffset) : "—"} ` +
      `mr=${(r.matchRatio * 100).toFixed(0)}% ${t.tone ? `(${t.tone}) ` : ""}` +
      `${t.speaker}: ${snippet}`
  );
}

console.log("\n=== Ground-truth cues in this region ===");
for (const c of gt) {
  if (c.start >= clipOffset - 2 && c.start <= clipOffset + asr.durationSeconds + 2) {
    const snippet = c.body.length > 60 ? c.body.slice(0, 60) + "…" : c.body;
    console.log(`[${secondsToCompact(c.start)}→${secondsToCompact(c.end)}] ${c.speaker}: ${snippet}`);
  }
}
