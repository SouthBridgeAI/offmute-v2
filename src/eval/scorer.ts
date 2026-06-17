/**
 * Eval scorer: compare a produced transcript against the hand-checked reference SRT.
 *
 * The output and reference have very different granularities (many short diarized
 * segments vs few long reference blocks), so per-segment text-Jaccard is misleading.
 * Instead we report: full-transcript WER (word streams), speaker agreement by
 * time-overlap, reference coverage, and boundary-timing error. (spec §4)
 */
import { readFileSync } from "node:fs";
import { parseSrt, type ParsedSrtEntry } from "../utils/srt.js";
import { tokenize } from "../align/normalize.js";
import { alignWords } from "../align/edit-distance.js";
import type { Segment } from "../core/types.js";

export interface RefEntry extends ParsedSrtEntry {
  speaker: string;
  cleanText: string;
}

/** Parse a reference SRT whose text lines look like "Speaker: words". */
export function parseReferenceSrt(path: string): RefEntry[] {
  const raw = readFileSync(path, "utf-8");
  return parseSrt(raw).map((e) => {
    const m = e.text.match(/^\s*([^:]+):\s*([\s\S]*)$/);
    return {
      ...e,
      speaker: m ? m[1]!.trim() : "?",
      cleanText: m ? m[2]!.trim() : e.text,
    };
  });
}

export interface EvalScore {
  /** Word error rate over the full transcript word streams. Lower is better. */
  wer: number;
  wordAccuracy: number;
  outputWords: number;
  referenceWords: number;
  /** Reference entries with an output segment overlapping their time. */
  referenceCoverage: number;
  referenceTotal: number;
  /** For each ref entry, |nearest output segment start - ref.start| within window. */
  boundaryErrorMedian: number;
  boundaryErrorP90: number;
  boundariesMatched: number;
  /** Speaker-label agreement via time-overlap majority mapping. */
  speakerAccuracy: number;
  speakerConfusion: Record<string, Record<string, number>>;
  /** Map: output speaker id → reference speaker (majority). */
  speakerMap: Record<string, string>;
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
function pct(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}

export function score(
  output: Segment[],
  reference: RefEntry[],
  opts: { boundaryWindowSec?: number } = {},
): EvalScore {
  const boundaryWindow = opts.boundaryWindowSec ?? 15;

  // ---- 1. Full-transcript WER ----
  const outTokens = tokenize(output.map((s) => s.text).join(" "));
  const refTokens = tokenize(reference.map((r) => r.cleanText).join(" "));
  const align = alignWords(outTokens, refTokens);
  const errors = align.substitutions + align.insertions + align.deletions;
  const wer = refTokens.length ? errors / refTokens.length : NaN;

  // ---- 2. Reference coverage (time overlap) ----
  let covered = 0;
  for (const r of reference) {
    if (output.some((s) => s.start < r.end && s.end > r.start)) covered++;
  }

  // ---- 3. Boundary timing ----
  const boundaryErrs: number[] = [];
  for (const r of reference) {
    let best = Infinity;
    for (const s of output) {
      const d = Math.abs(s.start - r.start);
      if (d < best) best = d;
    }
    if (best <= boundaryWindow) boundaryErrs.push(best);
  }

  // ---- 4. Speaker agreement by time-overlap majority mapping ----
  const confusion: Record<string, Record<string, number>> = {};
  for (const s of output) {
    // Which reference speakers are active during this segment's time?
    for (const r of reference) {
      const ov = Math.max(0, Math.min(s.end, r.end) - Math.max(s.start, r.start));
      if (ov > 0) {
        const outSp = s.speakerName || s.speaker;
        confusion[outSp] ??= {};
        confusion[outSp]![r.speaker] = (confusion[outSp]![r.speaker] ?? 0) + 1;
      }
    }
  }
  const speakerMap: Record<string, string> = {};
  for (const [outSp, counts] of Object.entries(confusion)) {
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (best) speakerMap[outSp] = best[0]!;
  }
  let correct = 0;
  let total = 0;
  for (const [outSp, counts] of Object.entries(confusion)) {
    for (const [refSp, c] of Object.entries(counts)) {
      total += c;
      if (speakerMap[outSp] === refSp) correct += c;
    }
  }

  return {
    wer,
    wordAccuracy: 1 - wer,
    outputWords: outTokens.length,
    referenceWords: refTokens.length,
    referenceCoverage: covered,
    referenceTotal: reference.length,
    boundaryErrorMedian: median(boundaryErrs),
    boundaryErrorP90: pct(boundaryErrs, 0.9),
    boundariesMatched: boundaryErrs.length,
    speakerAccuracy: total ? correct / total : NaN,
    speakerConfusion: confusion,
    speakerMap,
  };
}

export function printScore(s: EvalScore): void {
  console.log("=== EVAL ===");
  console.log(`words: output ${s.outputWords}, reference ${s.referenceWords}`);
  console.log(`WER: ${s.wer.toFixed(3)} (word accuracy ${(s.wordAccuracy * 100).toFixed(1)}%)`);
  console.log(
    `reference coverage: ${s.referenceCoverage}/${s.referenceTotal} entries have overlapping output`,
  );
  console.log(
    `boundary timing: ${s.boundariesMatched}/${s.referenceTotal} matched within window | median ${s.boundaryErrorMedian.toFixed(2)}s, p90 ${s.boundaryErrorP90.toFixed(2)}s`,
  );
  console.log(`speaker accuracy: ${isNaN(s.speakerAccuracy) ? NaN : (s.speakerAccuracy * 100).toFixed(0)}%`);
  console.log("speaker map (output → reference):");
  for (const [out, ref] of Object.entries(s.speakerMap)) {
    console.log(`  ${out} → ${ref}`);
  }
}
