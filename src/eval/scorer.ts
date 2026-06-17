/**
 * Eval scorer: compare a produced transcript against the hand-checked reference SRT.
 * Reports text-match coverage, timing error, and speaker-label agreement — the
 * objective signal for whether a change helped or hurt (spec §4).
 */
import { readFileSync } from "node:fs";
import { parseSrt, type ParsedSrtEntry } from "../utils/srt.js";
import { tokenize } from "../align/normalize.js";
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

function jaccard(a: string, b: string): number {
  const ta = new Set(tokenize(a).map((t) => t.norm));
  const tb = new Set(tokenize(b).map((t) => t.norm));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export interface EvalScore {
  outputSegments: number;
  referenceEntries: number;
  matchedOutput: number; // output segs that matched a ref entry (sim > thresh)
  matchedReference: number; // ref entries covered by an output seg
  matchRatio: number;
  /** |out.start - ref.start| over matched pairs. */
  startErrorMedian: number;
  startErrorP90: number;
  endErrorMedian: number;
  /** Speaker-label agreement via majority mapping. */
  speakerAccuracy: number;
  speakerConfusion: Record<string, Record<string, number>>;
}

export function score(
  output: Segment[],
  reference: RefEntry[],
  opts: { matchThreshold?: number } = {},
): EvalScore {
  const thresh = opts.matchThreshold ?? 0.3;
  const startErrs: number[] = [];
  const endErrs: number[] = [];
  let matchedOutput = 0;
  const coveredRef = new Set<number>();

  // For each output segment, find the best-matching reference entry.
  for (const seg of output) {
    let bestIdx = -1;
    let bestSim = 0;
    for (let i = 0; i < reference.length; i++) {
      const sim = jaccard(seg.text, reference[i]!.cleanText);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }
    if (bestSim >= thresh && bestIdx >= 0) {
      matchedOutput++;
      coveredRef.add(bestIdx);
      const ref = reference[bestIdx]!;
      startErrs.push(Math.abs(seg.start - ref.start));
      endErrs.push(Math.abs(seg.end - ref.end));
    }
  }

  // Speaker agreement: map output speaker → reference speaker by co-occurrence on matched pairs.
  const confusion: Record<string, Record<string, number>> = {};
  for (let i = 0; i < output.length; i++) {
    const seg = output[i]!;
    let bestIdx = -1;
    let bestSim = 0;
    for (let j = 0; j < reference.length; j++) {
      const sim = jaccard(seg.text, reference[j]!.cleanText);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = j;
      }
    }
    if (bestSim >= thresh && bestIdx >= 0) {
      const outSp = seg.speakerName || seg.speaker;
      const refSp = reference[bestIdx]!.speaker;
      confusion[outSp] ??= {};
      confusion[outSp]![refSp] = (confusion[outSp]![refSp] ?? 0) + 1;
    }
  }
  // Majority mapping + accuracy.
  let correct = 0;
  let total = 0;
  const majority: Record<string, string> = {};
  for (const [outSp, counts] of Object.entries(confusion)) {
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (best) majority[outSp] = best[0]!;
  }
  for (const [outSp, counts] of Object.entries(confusion)) {
    for (const [refSp, c] of Object.entries(counts)) {
      total += c;
      if (majority[outSp] === refSp) correct += c;
    }
  }

  const pct = (xs: number[], p: number) => {
    if (!xs.length) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  };
  const med = (xs: number[]) => pct(xs, 0.5);

  return {
    outputSegments: output.length,
    referenceEntries: reference.length,
    matchedOutput,
    matchedReference: coveredRef.size,
    matchRatio: output.length ? matchedOutput / output.length : 0,
    startErrorMedian: med(startErrs),
    startErrorP90: pct(startErrs, 0.9),
    endErrorMedian: med(endErrs),
    speakerAccuracy: total ? correct / total : NaN,
    speakerConfusion: confusion,
  };
}

export function printScore(s: EvalScore): void {
  console.log("=== EVAL ===");
  console.log(`output segments: ${s.outputSegments}, reference entries: ${s.referenceEntries}`);
  console.log(
    `text match: ${s.matchedOutput}/${s.outputSegments} output matched (${(s.matchRatio * 100).toFixed(0)}%), ${s.matchedReference}/${s.referenceEntries} reference covered`,
  );
  console.log(
    `timing error (matched pairs): start median ${s.startErrorMedian.toFixed(2)}s, p90 ${s.startErrorP90.toFixed(2)}s | end median ${s.endErrorMedian.toFixed(2)}s`,
  );
  console.log(`speaker accuracy: ${isNaN(s.speakerAccuracy) ? NaN : (s.speakerAccuracy * 100).toFixed(0)}%`);
  console.log("speaker confusion (out → ref counts):");
  for (const [out, counts] of Object.entries(s.speakerConfusion)) {
    console.log(`  ${out}: ${JSON.stringify(counts)}`);
  }
}
