/** Chunk-time calculation and overlap-merge of aligned segments. Browser-safe. */
import type { TimeChunk } from "../types.js";

/**
 * Split a duration into overlapping time chunks.
 * A trailing chunk shorter than 1/3 of chunkSeconds is merged into the previous one.
 */
export function calculateChunks(
  totalSeconds: number,
  chunkSeconds: number,
  overlapSeconds: number
): TimeChunk[] {
  if (totalSeconds <= chunkSeconds) {
    return [{ index: 0, startSeconds: 0, endSeconds: totalSeconds }];
  }
  // Clamp overlap to [0, 50% of chunk]: negative overlap leaves uncovered gaps;
  // overlap near/over the chunk size collapses the step and explodes the chunk
  // count. Real overlaps are small (~10-15%), so this only catches misconfig.
  const overlap = Math.max(0, Math.min(overlapSeconds, chunkSeconds * 0.5));
  const step = Math.max(1, chunkSeconds - overlap);
  const chunks: TimeChunk[] = [];
  let start = 0;
  let index = 0;
  while (start < totalSeconds) {
    const end = Math.min(start + chunkSeconds, totalSeconds);
    if (end >= totalSeconds && end - start < chunkSeconds / 3 && chunks.length > 0) {
      chunks[chunks.length - 1]!.endSeconds = end;
      break;
    }
    chunks.push({ index, startSeconds: start, endSeconds: end });
    index++;
    if (end >= totalSeconds) break;
    start += step;
  }
  return chunks;
}

/**
 * Partition the timeline so each chunk "owns" a contiguous, non-overlapping span:
 * the boundary between adjacent chunks is the midpoint of their overlap. Assigning
 * each output segment to the chunk that owns its center time means every piece of
 * speech is emitted exactly once — no overlap duplication — without fuzzy dedup.
 */
export function chunkOwnership(
  chunks: TimeChunk[],
  totalDuration: number
): Array<{ start: number; end: number }> {
  return chunks.map((c, i) => {
    const prev = chunks[i - 1];
    const next = chunks[i + 1];
    const start = i === 0 || !prev ? 0 : (prev.endSeconds + c.startSeconds) / 2;
    const end = i === chunks.length - 1 || !next ? totalDuration : (c.endSeconds + next.startSeconds) / 2;
    return { start, end };
  });
}

export interface MergeableSegment {
  start: number;
  end: number;
  speakerLabel: string;
  tone?: string;
  text: string;
  matchRatio: number;
  /** which chunk produced this segment */
  chunkIndex: number;
}

/**
 * Merge segments from overlapping chunks. In an overlap window the same speech is
 * transcribed twice; we keep the version from the chunk where the segment sits more
 * internally (away from that chunk's cut edge), which has better context. Concretely:
 * sort by start, then drop a segment if a previously-kept segment covers (nearly) the
 * same time span with similar text.
 */
export function mergeChunkSegments(
  segments: MergeableSegment[],
  chunkBoundaries: TimeChunk[]
): MergeableSegment[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
  const kept: MergeableSegment[] = [];

  for (const seg of sorted) {
    // A genuine duplicate comes from the OVERLAP between two DIFFERENT chunks
    // (same audio transcribed twice). Two cues from the SAME chunk are distinct
    // pieces of one turn, never duplicates. Note: we match on time+text, not
    // speaker label, because the same person can carry different labels across
    // chunks before the identify pass reconciles them.
    const dup = kept.find(
      (k) => k.chunkIndex !== seg.chunkIndex && timeOverlapRatio(k, seg) > 0.5 && textSimilar(k.text, seg.text)
    );
    if (!dup) {
      kept.push(seg);
      continue;
    }
    // choose the better of the two: prefer higher match ratio, then more-internal
    if (segmentScore(seg, chunkBoundaries) > segmentScore(dup, chunkBoundaries)) {
      kept[kept.indexOf(dup)] = seg;
    }
  }
  return kept.sort((a, b) => a.start - b.start);
}

function timeOverlapRatio(a: { start: number; end: number }, b: { start: number; end: number }): number {
  const lo = Math.max(a.start, b.start);
  const hi = Math.min(a.end, b.end);
  const inter = Math.max(0, hi - lo);
  const minLen = Math.max(0.01, Math.min(a.end - a.start, b.end - b.start));
  return inter / minLen;
}

/** Cheap text similarity: shared normalized-word ratio (Jaccard-ish). */
function textSimilar(a: string, b: string): boolean {
  const wa = new Set(a.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean));
  const wb = new Set(b.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return false;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const jaccard = inter / (wa.size + wb.size - inter);
  return jaccard > 0.4;
}

/** Higher = better: reward match ratio and distance from the chunk's cut edges. */
function segmentScore(seg: MergeableSegment, chunks: TimeChunk[]): number {
  const chunk = chunks[seg.chunkIndex];
  let edgeDistance = 999;
  if (chunk) {
    edgeDistance = Math.min(seg.start - chunk.startSeconds, chunk.endSeconds - seg.end);
  }
  return seg.matchRatio * 10 + Math.min(edgeDistance, 30);
}
