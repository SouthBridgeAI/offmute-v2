/**
 * Aligner: transfers accurate word-level timestamps from an ASR transcript onto the
 * richer LLM transcript (diarized, tone-annotated).
 *
 * Approach (ts-aligner): align the ENTIRE LLM token stream (all segments, in order)
 * against the ASR word stream in a single edit-distance DP pass, then split the
 * timed result back into segments. Long, ordered sequences pin common words ("the",
 * "as") to their correct occurrence — a per-segment windowed alignment scatters them
 * to later occurrences and drifts. One DP over the chunk is O(tokens × asrWords).
 */
import type { ParsedLlmSegment } from "../transcribe/llm-transcribe.js";
import type { TimestampedWord } from "../core/types.js";
import { tokenize } from "./normalize.js";
import { alignWords, type AlignOp } from "./edit-distance.js";

export interface AlignedWord {
  text: string;
  start: number;
  end: number;
  matched: boolean;
}

export interface AlignedSegment {
  speaker: string;
  /** Display name (set by the consistency/identification pass). */
  speakerName?: string;
  start: number; // accurate absolute seconds
  end: number;
  text: string; // LLM text preserved
  tone: string[];
  confidence: number; // exact-match ratio in [0,1]
  timingSource: "aligned" | "interpolated" | "coarse";
  words: AlignedWord[];
  sourceIndex: number;
}

export interface AlignOptions {
  /** Below this confidence, mark timing as interpolated (flag for repair). */
  confidenceThreshold?: number;
  /** Gate ASR to words within this many seconds of the LLM span (0 = use all). */
  timeMarginSec?: number;
}

interface AsrTok {
  text: string;
  start: number;
  end: number;
  norm: string;
}

interface LlmTok {
  original: string;
  norm: string;
  segIdx: number;
}

function toAsrTokens(words: TimestampedWord[]): AsrTok[] {
  return words.map((w) => ({
    text: w.text,
    start: w.start,
    end: w.end,
    norm: w.text.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/gi, ""),
  }));
}

/** Assign times to every LLM token from the aligned ops; interpolate inserts. */
function transferTiming(
  llm: LlmTok[],
  asr: AsrTok[],
  ops: AlignOp[],
): { start: number; end: number; matched: boolean }[] {
  const times = llm.map(() => ({ start: NaN, end: NaN, matched: false }));
  for (const op of ops) {
    if (op.type === "match" || op.type === "substitute") {
      const a = asr[op.asr]!;
      times[op.llm] = { start: a.start, end: a.end, matched: op.type === "match" && !op.fuzzy };
    }
  }
  // Interpolate inserted (unmatched) tokens from neighboring matched tokens.
  for (let k = 0; k < times.length; k++) {
    if (!isNaN(times[k]!.start)) continue;
    let prevEnd: number | null = null;
    for (let p = k - 1; p >= 0; p--) {
      if (!isNaN(times[p]!.start)) {
        prevEnd = times[p]!.end;
        break;
      }
    }
    let nextStart: number | null = null;
    for (let q = k + 1; q < times.length; q++) {
      if (!isNaN(times[q]!.start)) {
        nextStart = times[q]!.start;
        break;
      }
    }
    if (prevEnd !== null && nextStart !== null) {
      // Bound the run to the current segment so interpolation doesn't bleed across
      // a segment boundary.
      const segIdx = llm[k]!.segIdx;
      let runLen = 0;
      for (
        let r = k;
        r < times.length && isNaN(times[r]!.start) && llm[r]!.segIdx === segIdx;
        r++
      )
        runLen++;
      const step = (nextStart - prevEnd) / (runLen + 1);
      for (let r = 0; r < runLen; r++) {
        const pt = prevEnd + step * (r + 1);
        times[k + r] = { start: pt, end: pt, matched: false };
      }
      k += runLen - 1;
    } else if (nextStart !== null) {
      times[k] = { start: nextStart, end: nextStart, matched: false };
    } else if (prevEnd !== null) {
      times[k] = { start: prevEnd, end: prevEnd, matched: false };
    }
  }
  return times;
}

/** Align LLM segments to ASR words (single DP over the chunk). Segments need not be sorted. */
export function alignSegments(
  llmSegments: ParsedLlmSegment[],
  asrWords: TimestampedWord[],
  opts: AlignOptions = {},
): AlignedSegment[] {
  const confThreshold = opts.confidenceThreshold ?? 0.5;
  const margin = opts.timeMarginSec ?? 0;

  const sorted = [...llmSegments].map((s, i) => ({ s, i })).sort((a, b) => a.s.startSec - b.s.startSec);

  // Build flat LLM token stream + per-segment token ranges.
  const flat: LlmTok[] = [];
  const segRanges: { src: number; start: number; end: number }[] = [];
  for (const { s, i } of sorted) {
    const toks = tokenize(s.text);
    const start = flat.length;
    for (const t of toks) flat.push({ original: t.original, norm: t.norm, segIdx: i });
    segRanges.push({ src: i, start, end: flat.length });
  }

  if (flat.length === 0 || asrWords.length === 0) {
    return sorted.map(({ s, i }) => ({
      speaker: s.speaker,
      start: s.startSec,
      end: s.endSec,
      text: s.text,
      tone: s.tone,
      confidence: 0,
      timingSource: "coarse" as const,
      words: [],
      sourceIndex: i,
    }));
  }

  // Optionally gate ASR to the LLM span (±margin) to shrink the DP.
  let asr = toAsrTokens(asrWords);
  if (margin > 0) {
    const lo = sorted[0]!.s.startSec - margin;
    const hi = sorted[sorted.length - 1]!.s.endSec + margin;
    asr = asr.filter((w) => w.end >= lo && w.start <= hi);
  }

  const result = alignWords(flat, asr);
  const times = transferTiming(flat, asr, result.ops);

  if (process.env.ALIGN_DEBUG) {
    console.error(
      `[align] flat=${flat.length} asr=${asr.length} exact=${result.exactMatches} fuzzy=${result.fuzzyMatches} subs=${result.substitutions} ins=${result.insertions} del=${result.deletions}`,
    );
  }

  const out: AlignedSegment[] = [];
  for (let si = 0; si < sorted.length; si++) {
    const { s, i } = sorted[si]!;
    const range = segRanges[si]!;
    const segTimes = times.slice(range.start, range.end);
    const segOps = result.ops.filter(
      (op) => (op.type === "match" || op.type === "substitute") && op.llm >= range.start && op.llm < range.end,
    );
    const exact = segOps.filter((op) => op.type === "match" && !op.fuzzy).length;
    const tokenCount = range.end - range.start;

    const firstTimed = segTimes.find((t) => !isNaN(t.start));
    const lastTimed = [...segTimes].reverse().find((t) => !isNaN(t.end));

    let start: number;
    let end: number;
    let timingSource: AlignedSegment["timingSource"];
    const confidence = tokenCount ? exact / tokenCount : 0;

    if (firstTimed && lastTimed) {
      start = firstTimed.start;
      end = lastTimed.end;
      timingSource = confidence >= confThreshold ? "aligned" : "interpolated";
    } else {
      start = s.startSec;
      end = s.endSec;
      timingSource = "coarse";
    }

    const words: AlignedWord[] = segTimes.map((t, idx) => ({
      text: flat[range.start + idx]!.original,
      start: isNaN(t.start) ? start : t.start,
      end: isNaN(t.end) ? end : t.end,
      matched: t.matched,
    }));

    out.push({
      speaker: s.speaker,
      start,
      end,
      text: s.text,
      tone: s.tone,
      confidence,
      timingSource,
      words,
      sourceIndex: i,
    });
  }

  return out;
}
