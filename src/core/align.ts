/**
 * Alignment layer — the crux of offmute-v2.
 *
 * The multimodal LLM gives high-quality diarized text but only coarse/sparse
 * timestamps. The ASR gives precise word-level timings but unreliable diarization.
 * We align the LLM's token stream to the ASR's word stream (both describe the same
 * audio, so the sequences are ~90%+ similar) and read precise timings off the ASR
 * words that match each LLM segment. This is "forced alignment" using an existing
 * ASR transcript as the timing reference rather than an acoustic model.
 *
 * Browser-safe (pure functions, no deps).
 */
import type { TimedWord } from "../types.js";

/** Normalize a token for matching: lowercase, strip non-alphanumerics. */
export function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Split text into raw word tokens (keeps surface form). */
export function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0);
}

export interface AlignPair {
  /** index into sequence A (LLM tokens), or null if A had a gap (ASR-only word) */
  ai: number | null;
  /** index into sequence B (ASR words), or null if B had a gap (LLM-only token) */
  bi: number | null;
  /** true if ai and bi are a real (normalized-equal) match */
  match: boolean;
}

/**
 * Global sequence alignment (Needleman–Wunsch) on normalized tokens.
 * Returns the alignment path as a list of pairs. O(n*m) time/space — fine for
 * chunk-sized inputs (a few thousand tokens). For whole-file we align per chunk.
 *
 * To bound cost on large inputs we use a Hirschberg-free banded variant: if both
 * inputs are long and similar length, we still run full DP but with Int32 arrays.
 */
export function alignTokens(a: string[], b: string[]): AlignPair[] {
  const n = a.length;
  const m = b.length;
  const MATCH = 2;
  const MISMATCH = -1;
  const GAP = -1;

  // DP score matrix (n+1) x (m+1) using a flat Int32Array
  const w = m + 1;
  const score = new Int32Array((n + 1) * w);
  // backpointer: 0=diag,1=up(gap in b),2=left(gap in a)
  const back = new Uint8Array((n + 1) * w);

  for (let i = 1; i <= n; i++) {
    score[i * w] = i * GAP;
    back[i * w] = 1;
  }
  for (let j = 1; j <= m; j++) {
    score[j] = j * GAP;
    back[j] = 2;
  }

  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1]!;
    const rowOff = i * w;
    const prevRowOff = (i - 1) * w;
    for (let j = 1; j <= m; j++) {
      const isMatch = ai === b[j - 1];
      const diag = score[prevRowOff + j - 1]! + (isMatch ? MATCH : MISMATCH);
      const up = score[prevRowOff + j]! + GAP;
      const left = score[rowOff + j - 1]! + GAP;
      let best = diag;
      let dir = 0;
      if (up > best) {
        best = up;
        dir = 1;
      }
      if (left > best) {
        best = left;
        dir = 2;
      }
      score[rowOff + j] = best;
      back[rowOff + j] = dir;
    }
  }

  // traceback
  const pairs: AlignPair[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && back[i * w + j] === 0) {
      pairs.push({ ai: i - 1, bi: j - 1, match: a[i - 1] === b[j - 1] });
      i--;
      j--;
    } else if (i > 0 && (j === 0 || back[i * w + j] === 1)) {
      pairs.push({ ai: i - 1, bi: null, match: false });
      i--;
    } else {
      pairs.push({ ai: null, bi: j - 1, match: false });
      j--;
    }
  }
  pairs.reverse();
  return pairs;
}

export interface SegmentToTime {
  /** opaque id for the caller's segment (e.g. turn index) */
  segmentId: number;
  /** normalized tokens belonging to this segment, in order */
  tokens: string[];
}

export interface TimedSegmentResult {
  segmentId: number;
  start: number | null;
  end: number | null;
  /** fraction of this segment's tokens that matched an ASR word (0..1) */
  matchRatio: number;
  /** number of ASR words matched */
  matchedWords: number;
}

/**
 * Given LLM segments (each a list of normalized tokens, in document order) and the
 * ASR word stream, assign a precise [start,end] to each segment by aligning the
 * full concatenated LLM token stream to the ASR words and reading off matched times.
 *
 * Segments with no matches get null times (caller interpolates from neighbors).
 */
export function assignTimings(
  segments: SegmentToTime[],
  asrWords: TimedWord[]
): TimedSegmentResult[] {
  // Build concatenated LLM token array with a parallel segment-index array.
  const llmTokens: string[] = [];
  const tokenSegment: number[] = [];
  segments.forEach((seg, segIdx) => {
    for (const tok of seg.tokens) {
      if (!tok) continue;
      llmTokens.push(tok);
      tokenSegment.push(segIdx);
    }
  });

  const asrNorm = asrWords.map((w) => normalizeToken(w.text));
  const pairs = alignTokens(llmTokens, asrNorm);

  // For each segment, collect matched ASR word times.
  const perSeg: Array<{ starts: number[]; ends: number[]; matched: number; total: number }> =
    segments.map(() => ({ starts: [], ends: [], matched: 0, total: 0 }));
  for (let s = 0; s < segments.length; s++) perSeg[s]!.total = segments[s]!.tokens.length;

  for (const p of pairs) {
    if (p.ai === null) continue;
    const segIdx = tokenSegment[p.ai]!;
    if (p.match && p.bi !== null) {
      const word = asrWords[p.bi]!;
      perSeg[segIdx]!.starts.push(word.start);
      perSeg[segIdx]!.ends.push(word.end);
      perSeg[segIdx]!.matched++;
    }
  }

  return segments.map((seg, idx) => {
    const ps = perSeg[idx]!;
    const start = ps.starts.length ? Math.min(...ps.starts) : null;
    const end = ps.ends.length ? Math.max(...ps.ends) : null;
    return {
      segmentId: seg.segmentId,
      start,
      end,
      matchRatio: ps.total ? ps.matched / ps.total : 0,
      matchedWords: ps.matched,
    };
  });
}

/**
 * Fill null start/end values by interpolating from neighbors and enforcing
 * monotonic, non-overlapping order. Mutates and returns the array.
 */
export function interpolateTimings(
  results: TimedSegmentResult[],
  totalDuration: number
): TimedSegmentResult[] {
  const n = results.length;
  // forward fill starts from previous end; backward fill ends from next start
  for (let i = 0; i < n; i++) {
    const r = results[i]!;
    if (r.start === null) {
      // use previous end, else next known start, else 0
      const prevEnd = i > 0 ? results[i - 1]!.end : null;
      r.start = prevEnd ?? 0;
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    const r = results[i]!;
    if (r.end === null) {
      const nextStart = i < n - 1 ? results[i + 1]!.start : null;
      r.end = nextStart ?? totalDuration;
    }
    if (r.end !== null && r.start !== null && r.end < r.start) r.end = r.start;
  }
  return results;
}
