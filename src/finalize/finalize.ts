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
  let deduped = dedupSegments(segments);
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
