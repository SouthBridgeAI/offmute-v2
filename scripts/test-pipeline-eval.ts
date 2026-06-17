/**
 * Full-pipeline prototype + eval: parse Gemini diarization, align to ASR words,
 * emit aligned SRT, and evaluate against ground-truth SRT.
 * Run: bun run scripts/test-pipeline-eval.ts [clip] [model]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseDiarizedText } from "../src/core/parse-diarized.js";
import { assignTimings, interpolateTimings, normalizeToken, tokenize } from "../src/core/align.js";
import { parseSrt, formatSrt } from "../src/core/srt.js";
import { secondsToCompact } from "../src/core/time.js";
import { evaluateWords, segmentsToWords, type TimedSegment } from "../src/core/eval.js";
import type { AsrResult } from "../src/types.js";

const clip = process.argv[2] ?? "talk-full";
const model = process.argv[3] ?? "gemini-flash-latest";
const root = join(import.meta.dir, "../..");
const outDir = join(root, "intermediates/eval");
mkdirSync(outDir, { recursive: true });

const geminiTxt = readFileSync(join(root, `intermediates/gemini/${clip}.${model}.txt`), "utf8");
const asr = JSON.parse(readFileSync(join(root, `intermediates/asr/${clip}.asr.json`), "utf8")) as AsrResult;

const turns = parseDiarizedText(geminiTxt);
const segs = turns.map((t, i) => ({ segmentId: i, tokens: tokenize(t.text).map(normalizeToken).filter(Boolean) }));
const timed = assignTimings(segs, asr.words);
interpolateTimings(timed, asr.durationSeconds);

// Build hypothesis timed segments; drop empty/no-match "turns" (e.g. (applause))
const hyp: TimedSegment[] = [];
let dropped = 0;
for (let i = 0; i < turns.length; i++) {
  const t = turns[i]!;
  const r = timed[i]!;
  const wordCount = segs[i]!.tokens.length;
  if (wordCount === 0 || r.matchedWords === 0) {
    dropped++;
    continue;
  }
  hyp.push({ start: r.start ?? 0, end: r.end ?? 0, speaker: t.speaker, text: t.text });
}

// Emit aligned SRT
const srt = formatSrt(hyp.map((s) => ({ start: s.start, end: s.end, speaker: s.speaker, text: s.text })));
writeFileSync(join(outDir, `${clip}.${model}.aligned.srt`), srt);

// Evaluate
const gtCues = parseSrt(readFileSync(join(root, "test-files/1/talk-with-questions.srt"), "utf8"));
const refSegs: TimedSegment[] = gtCues.map((c) => ({
  start: c.start,
  end: c.end,
  speaker: c.speaker ?? "?",
  text: c.body,
}));
const refWords = segmentsToWords(refSegs);
const hypWords = segmentsToWords(hyp);
const ev = evaluateWords(refWords, hypWords);

console.log(`\n===== PIPELINE EVAL: ${clip} / ${model} =====`);
console.log(`LLM turns=${turns.length} (dropped ${dropped} no-match) → hyp segments=${hyp.length}`);
console.log(`ASR words=${asr.words.length}  ASR speakers=[${asr.speakers.join(",")}]`);
console.log(`\n--- Text ---`);
console.log(`WER: ${(ev.wer * 100).toFixed(1)}%  (ref=${ev.refWords} hyp=${ev.hypWords}; S=${ev.substitutions} D=${ev.deletions} I=${ev.insertions} C=${ev.correct})`);
console.log(`\n--- Speakers ---`);
console.log(`Word-level speaker accuracy: ${(ev.speakerAccuracy * 100).toFixed(1)}%  (over ${ev.matchedForSpeaker} matched words)`);
console.log(`Mapping (hyp→ref):`, ev.speakerMapping);
console.log(`\n--- Timing (vs ground truth, over ${ev.timedMatches} matched words) ---`);
console.log(`median=${ev.timeMedian.toFixed(2)}s  p90=${ev.timeP90.toFixed(2)}s  mean=${ev.timeMean.toFixed(2)}s`);

console.log(`\n--- First 6 aligned segments ---`);
for (const s of hyp.slice(0, 6)) {
  const snip = s.text.length > 60 ? s.text.slice(0, 60) + "…" : s.text;
  console.log(`[${secondsToCompact(s.start)}→${secondsToCompact(s.end)}] ${s.speaker}: ${snip}`);
}
console.log(`--- Last 4 aligned segments (drift check: should end ~31:5x) ---`);
for (const s of hyp.slice(-4)) {
  const snip = s.text.length > 60 ? s.text.slice(0, 60) + "…" : s.text;
  console.log(`[${secondsToCompact(s.start)}→${secondsToCompact(s.end)}] ${s.speaker}: ${snip}`);
}
console.log(`\nWrote ${join(outDir, `${clip}.${model}.aligned.srt`)}`);
