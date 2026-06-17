/**
 * Evaluate any diarized SRT against a reference SRT.
 * Run: bun run scripts/eval-srt.ts <hyp.srt> [ref.srt]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSrt } from "../src/core/srt.js";
import { evaluateWords, segmentsToWords, type TimedSegment } from "../src/core/eval.js";

const hypPath = process.argv[2];
const refPath = process.argv[3] ?? join(import.meta.dir, "../../test-files/1/talk-with-questions.srt");
if (!hypPath) {
  console.error("usage: bun run scripts/eval-srt.ts <hyp.srt> [ref.srt]");
  process.exit(1);
}

const toSegs = (path: string): TimedSegment[] =>
  parseSrt(readFileSync(path, "utf8")).map((c) => ({
    start: c.start,
    end: c.end,
    speaker: c.speaker ?? "?",
    text: c.body,
  }));

const ref = toSegs(refPath);
const hyp = toSegs(hypPath);
const ev = evaluateWords(segmentsToWords(ref), segmentsToWords(hyp));

console.log(`\n=== eval ${hypPath.split("/").pop()} vs ${refPath.split("/").pop()} ===`);
console.log(`ref cues=${ref.length} hyp cues=${hyp.length}`);
console.log(`WER          ${(ev.wer * 100).toFixed(1)}%   (S=${ev.substitutions} D=${ev.deletions} I=${ev.insertions} C=${ev.correct} / ref ${ev.refWords})`);
console.log(`Speaker acc  ${(ev.speakerAccuracy * 100).toFixed(1)}%   over ${ev.matchedForSpeaker} matched words`);
console.log(`  mapping`, ev.speakerMapping);
console.log(`Boundary err median ${ev.boundaryMedian.toFixed(2)}s  p90 ${ev.boundaryP90.toFixed(2)}s  mean ${ev.boundaryMean.toFixed(2)}s  (${ev.boundaryMatches} cue-starts)`);
