/**
 * Full-pipeline prototype + eval: parse Gemini diarization, align to ASR words
 * (token-level), optionally sub-segment into display cues, emit SRT, evaluate vs GT.
 * Run: bun run scripts/test-pipeline-eval.ts [clip] [model] [sub|turn]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseDiarizedText } from "../src/core/parse-diarized.js";
import { alignLlmToAsr, fillTokenTimes, buildSegmentsFromTokens } from "../src/core/align.js";
import { parseSrt, formatSrt } from "../src/core/srt.js";
import { secondsToCompact } from "../src/core/time.js";
import { evaluateWords, segmentsToWords, type TimedSegment } from "../src/core/eval.js";
import type { AsrResult } from "../src/types.js";

const clip = process.argv[2] ?? "talk-full";
const model = process.argv[3] ?? "gemini-flash-latest";
const mode = process.argv[4] ?? "sub"; // "sub" | "turn"
const root = join(import.meta.dir, "../..");
const outDir = join(root, "intermediates/eval");
mkdirSync(outDir, { recursive: true });

const geminiTxt = readFileSync(join(root, `intermediates/gemini/${clip}.${model}.txt`), "utf8");
const asr = JSON.parse(readFileSync(join(root, `intermediates/asr/${clip}.asr.json`), "utf8")) as AsrResult;

const turns = parseDiarizedText(geminiTxt);
const tokens = alignLlmToAsr(turns, asr.words);
fillTokenTimes(tokens, asr.durationSeconds);
const aligned = buildSegmentsFromTokens(turns, tokens, { subSegment: mode === "sub" });

// Build hypothesis timed segments; carry speaker/tone from the turn
const hyp: TimedSegment[] = [];
let dropped = 0;
for (const seg of aligned) {
  if (seg.matchedTokens === 0) {
    dropped++;
    continue;
  }
  const turn = turns[seg.turnIndex]!;
  hyp.push({ start: seg.start, end: seg.end, speaker: turn.speaker, text: seg.text });
}

const srt = formatSrt(hyp.map((s) => ({ start: s.start, end: s.end, speaker: s.speaker, text: s.text })));
writeFileSync(join(outDir, `${clip}.${model}.${mode}.srt`), srt);

const gtCues = parseSrt(readFileSync(join(root, "test-files/1/talk-with-questions.srt"), "utf8"));
const refSegs: TimedSegment[] = gtCues.map((c) => ({ start: c.start, end: c.end, speaker: c.speaker ?? "?", text: c.body }));
const ev = evaluateWords(segmentsToWords(refSegs), segmentsToWords(hyp));

console.log(`\n===== PIPELINE EVAL: ${clip} / ${model} / mode=${mode} =====`);
console.log(`LLM turns=${turns.length} → segments=${aligned.length} (dropped ${dropped} no-match) → hyp=${hyp.length}`);
console.log(`WER ${(ev.wer * 100).toFixed(1)}%  | speaker ${(ev.speakerAccuracy * 100).toFixed(1)}%`);
console.log(`timing (word, noisy) med ${ev.timeMedian.toFixed(2)}s p90 ${ev.timeP90.toFixed(2)}s`);
console.log(`BOUNDARY (clean) med ${ev.boundaryMedian.toFixed(2)}s p90 ${ev.boundaryP90.toFixed(2)}s mean ${ev.boundaryMean.toFixed(2)}s  over ${ev.boundaryMatches} cue-starts`);
console.log(`(S=${ev.substitutions} D=${ev.deletions} I=${ev.insertions} C=${ev.correct}; mapping`, ev.speakerMapping, ")");

console.log(`\n--- sample cues 1-10 ---`);
for (const s of hyp.slice(0, 10)) {
  const snip = s.text.length > 64 ? s.text.slice(0, 64) + "…" : s.text;
  console.log(`[${secondsToCompact(s.start)}→${secondsToCompact(s.end)}] ${s.speaker}: ${snip}`);
}
console.log(`Wrote ${clip}.${model}.${mode}.srt`);
