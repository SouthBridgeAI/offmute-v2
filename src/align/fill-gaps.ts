/**
 * Gap-fill: after alignment, recover content the LLM dropped. Where ASR has speech in a
 * time gap not covered by any LLM segment (e.g. a dropped opening word like "GPU"), insert
 * an ASR-derived fallback segment (timingSource "timestamped"). Skips gaps already covered
 * by an adjacent segment's *text* (timing imprecision, not a real drop) to avoid duplicates.
 */
import type { AlignedSegment } from "./aligner.js";
import type { TimestampedWord, TimestampedUtterance } from "../core/types.js";
import { tokenize } from "./normalize.js";

const MIN_GAP_SEC = 0.8; // only fill gaps at least this wide
const MIN_WORDS = 1; // fill if at least this many ASR words in the gap

function normSet(text: string): Set<string> {
  return new Set(tokenize(text).map((t) => t.norm));
}

export function fillAsrGaps(
  segments: AlignedSegment[],
  asrWords: TimestampedWord[],
  asrUtterances: TimestampedUtterance[],
): AlignedSegment[] {
  if (!asrWords.length) return segments;
  const sorted = [...segments].sort((a, b) => a.start - b.start);

  // Build gap ranges [start, end] not covered by any segment, before/between segments
  // (not after the last — trailing silence isn't dropped content).
  const ranges: Array<[number, number, AlignedSegment | undefined]> = [];
  const firstStart = sorted.length ? sorted[0]!.start : asrWords[asrWords.length - 1]!.end;
  if (firstStart > 0) ranges.push([0, firstStart, sorted[0]]);
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i]!;
    const next = sorted[i + 1]!;
    if (next.start > cur.end) ranges.push([cur.end, next.start, next]);
  }

  const filled: AlignedSegment[] = [];
  for (const [gs, ge, following] of ranges) {
    if (ge - gs < MIN_GAP_SEC) continue;
    const words = asrWords.filter((w) => w.start >= gs && w.start < ge);
    if (words.length < MIN_WORDS) continue;

    // Skip if the gap's words are already in the following segment's text — that's a
    // timing imprecision (the word is in the text, just the segment start is late), not
    // a real drop. Filling it would duplicate.
    if (following) {
      const followingWords = normSet(following.text);
      const gapNorms = words.map((w) =>
        w.text.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/gi, ""),
      );
      const covered = gapNorms.filter((n) => n && followingWords.has(n)).length;
      if (covered / gapNorms.filter(Boolean).length >= 0.6) continue;
    }

    // Dominant ASR utterance speaker in the gap.
    let bestSp = asrUtterances[0]?.speaker || "speaker_?";
    let bestOv = 0;
    for (const u of asrUtterances) {
      const ov = Math.max(0, Math.min(ge, u.end) - Math.max(gs, u.start));
      if (ov > bestOv) {
        bestOv = ov;
        bestSp = u.speaker;
      }
    }

    filled.push({
      speaker: bestSp,
      start: words[0]!.start,
      end: words[words.length - 1]!.end,
      text: words.map((w) => w.text).join(" "),
      tone: [],
      confidence: 0,
      timingSource: "timestamped",
      words: words.map((w) => ({ text: w.text, start: w.start, end: w.end, matched: true })),
      sourceIndex: -1,
    });
  }

  if (!filled.length) return sorted;
  return [...sorted, ...filled].sort((a, b) => a.start - b.start);
}
