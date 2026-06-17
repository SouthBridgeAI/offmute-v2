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
  const step = Math.max(1, chunkSeconds - overlapSeconds);
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
    // find an already-kept segment that overlaps this one substantially in time
    const dup = kept.find((k) => timeOverlapRatio(k, seg) > 0.5 && textSimilar(k.text, seg.text));
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
