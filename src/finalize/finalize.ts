/**
 * Finalize: dedup chunk-overlap duplicates, fix timestamp overlaps, clamp durations,
 * and produce the final renumbered Segment list ready for formatting.
 *
 * Improvements over ipgu's finalizer: (1) fuzzy near-duplicate dedup (we have no
 * reference SRT ids to dedup by), (2) a FINAL overlap re-check pass after clamping
 * (ipgu noted clamping can re-introduce overlaps but didn't re-check).
 */
import type { AlignedSegment } from "../align/aligner.js";
import type { Segment } from "../core/types.js";
import { tokenize } from "../align/normalize.js";

const MIN_DUR = 0.5;
const MAX_DUR = 7.0;
const OVERLAP_GAP = 0.05; // 50ms gap between adjacent blocks

/** Jaccard similarity on normalized token sets. */
function textSimilarity(a: string, b: string): number {
  const ta = new Set(tokenize(a).map((t) => t.norm));
  const tb = new Set(tokenize(b).map((t) => t.norm));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

function timeOverlapFrac(a: { start: number; end: number }, b: { start: number; end: number }): number {
  const ov = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const shorter = Math.min(a.end - a.start, b.end - b.start);
  return shorter > 0 ? ov / shorter : 0;
}

const SEAM_WINDOW = 250; // tokens examined on each side of a candidate seam
const SEAM_MIN_TOKENS = 6;
const SEAM_MIN_SCORE_RATIO = 0.5; // matches must clearly outweigh edits

/**
 * Overlap alignment (suffix of A vs prefix of B): free leading gap in A, free trailing
 * gap in B; +1 match / −1 mismatch/indel. Returns the aligned span, or null when no
 * window scores well enough to be a duplicate.
 */
export function suffixPrefixOverlap(
  a: string[],
  b: string[],
): { aStart: number; bLen: number } | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return null;
  // dp[i][j]: best score aligning some suffix of a[0..i) to exactly b[0..j).
  // origin[i][j]: where that suffix starts in `a`.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  const origin: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) {
    dp[i]![0] = 0; // leading gap in `a` is free
    origin[i]![0] = i;
  }
  for (let j = 1; j <= m; j++) {
    dp[0]![j] = -j;
    origin[0]![j] = 0;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 1 : -1);
      const up = dp[i - 1]![j]! - 1;
      const left = dp[i]![j - 1]! - 1;
      if (diag >= up && diag >= left) {
        dp[i]![j] = diag;
        origin[i]![j] = origin[i - 1]![j - 1]!;
      } else if (up >= left) {
        dp[i]![j] = up;
        origin[i]![j] = origin[i - 1]![j]!;
      } else {
        dp[i]![j] = left;
        origin[i]![j] = origin[i]![j - 1]!;
      }
    }
  }
  // The duplicate must reach a's END (that's where the seam truncated it); b may
  // continue past it (free trailing gap) — take the best j at i = n.
  let bestJ = 0;
  let bestScore = -Infinity;
  for (let j = 1; j <= m; j++) {
    if (dp[n]![j]! > bestScore) {
      bestScore = dp[n]![j]!;
      bestJ = j;
    }
  }
  if (bestJ < SEAM_MIN_TOKENS) return null;
  if (bestScore < bestJ * SEAM_MIN_SCORE_RATIO) return null;
  return { aStart: origin[n]![bestJ]!, bLen: bestJ };
}

/**
 * Trim chunk-seam duplicates. Ownership partitioning drops whole segments in the
 * overlap zone, but a MEGA-segment that spans the boundary survives in both chunks:
 * chunk N's copy ends truncated mid-sentence, chunk N+1's re-covers the same speech in
 * full before continuing (observed live on the SuperAI panel). The duplicate is a
 * suffix of the earlier segment ≈ a prefix of the later one — located by overlap
 * alignment (order-sensitive, tolerant of word-level diffs) and trimmed from the
 * EARLIER copy, keeping the later chunk's fuller version (the ipgu convention).
 * Same-speaker only, so genuine cross-talk is untouched.
 */
export function trimSeamOverlaps(segments: AlignedSegment[]): AlignedSegment[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const lastIdxBySpeaker = new Map<string, number>();
  const out: (AlignedSegment | null)[] = [];
  for (const seg of sorted) {
    const prevIdx = lastIdxBySpeaker.get(seg.speaker);
    const prev = prevIdx !== undefined ? out[prevIdx] : undefined;
    if (prev && prev.words?.length && seg.words?.length) {
      const prevWin = Math.min(SEAM_WINDOW, prev.words.length);
      const prevToks = prev.words
        .slice(-prevWin)
        .map((w) => tokenize(w.text)[0]?.norm ?? "");
      const segToks = seg.words
        .slice(0, SEAM_WINDOW)
        .map((w) => tokenize(w.text)[0]?.norm ?? "");
      const hit = suffixPrefixOverlap(prevToks, segToks);
      if (hit) {
        const trimFrom = prev.words.length - prevWin + hit.aStart;
        const kept = prev.words.slice(0, trimFrom);
        if (kept.length === 0) {
          out[prevIdx!] = null; // earlier copy entirely re-covered
        } else {
          out[prevIdx!] = {
            ...prev,
            words: kept,
            end: kept[kept.length - 1]!.end,
            text: kept.map((w) => w.text).join(" "),
          };
        }
      }
    }
    out.push(seg);
    lastIdxBySpeaker.set(seg.speaker, out.length - 1);
  }
  return out.filter((s): s is AlignedSegment => s !== null);
}

/** Drop near-duplicate segments (chunk overlap transcribed twice). Keeps the higher-confidence one. */
export function dedupSegments(segments: AlignedSegment[]): AlignedSegment[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const kept: AlignedSegment[] = [];
  for (const seg of sorted) {
    const dup = kept.find(
      (k) =>
        k.speaker === seg.speaker &&
        textSimilarity(k.text, seg.text) > 0.7 &&
        timeOverlapFrac(k, seg) > 0.2,
    );
    if (dup) {
      // Replace if this one is higher confidence.
      if (seg.confidence > dup.confidence) {
        Object.assign(dup, seg);
      }
      continue;
    }
    kept.push(seg);
  }
  return kept;
}

/** Shorten overlapping blocks so they don't collide; iterates until stable. */
export function fixOverlaps(segments: Segment[]): Segment[] {
  if (segments.length === 0) return segments;
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    for (let i = 0; i < sorted.length - 1; i++) {
      const cur = sorted[i]!;
      const next = sorted[i + 1]!;
      if (cur.end > next.start) {
        const targetEnd = next.start - OVERLAP_GAP;
        const newDur = targetEnd - cur.start;
        if (newDur >= MIN_DUR) {
          cur.end = targetEnd;
          changed = true;
        } else {
          // Can't shorten without violating min dur; shift next's start to cur.end + gap
          // only if it keeps next valid AND doesn't overtake the following segment (which
          // would unsort the array and skip a real overlap).
          const shiftedStart = cur.end + OVERLAP_GAP;
          const followingStart = sorted[i + 2]?.start ?? Infinity;
          if (shiftedStart < next.end - MIN_DUR && shiftedStart < followingStart) {
            next.start = shiftedStart;
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }
  return sorted;
}

/** Clamp each block's duration to [MIN_DUR, MAX_DUR], then re-check overlaps. */
export function clampAndFix(segments: Segment[]): Segment[] {
  for (const s of segments) {
    const dur = s.end - s.start;
    if (dur < MIN_DUR) s.end = s.start + MIN_DUR;
    else if (dur > MAX_DUR) s.end = s.start + MAX_DUR;
  }
  // Final re-check: clamping may have re-introduced overlaps (ipgu's known gap).
  return fixOverlaps(segments);
}

export interface FinalizeOptions {
  /** Drop segments shorter than this (seconds). */
  minSegmentSec?: number;
}

/** Convert aligned+consistent segments into the final Segment list (renumbered, deduped, clamped). */
export function finalizeSegments(
  segments: AlignedSegment[],
  opts: FinalizeOptions = {},
): Segment[] {
  const minSeg = opts.minSegmentSec ?? 0.2;
  let deduped = dedupSegments(trimSeamOverlaps(segments));
  // Drop trivially short / empty segments.
  deduped = deduped.filter((s) => s.end - s.start >= minSeg && s.text.trim().length > 0);

  const out: Segment[] = deduped.map((s, i) => ({
    id: i + 1,
    start: s.start,
    end: s.end,
    speaker: s.speaker,
    speakerName: s.speakerName || s.speaker,
    // Collapse any internal whitespace (incl. newlines) so a stray blank line in the LLM
    // text can never split one SRT cue into several — SRT cues end at a blank line.
    text: s.text.trim().replace(/\s+/g, " "),
    tone: s.tone,
    timingSource: s.timingSource,
    confidence: s.confidence,
    words: s.words,
  }));

  return clampAndFix(out);
}
