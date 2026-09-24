/**
 * Gap-fill: after alignment, recover content the LLM dropped. Where ASR has speech in a
 * time range no LLM segment covers — before the first segment (a dropped opening word
 * like "GPU"), between segments, or after the last one (a final chunk the LLM stopped
 * transcribing early) — insert ASR-derived fallback segments (timingSource "timestamped"),
 * one per ASR utterance so the speaker turns inside a long recovered range survive.
 * Skips gaps already covered by the following segment's *text* (timing imprecision, not
 * a real drop) to avoid duplicates.
 */
import type { AlignedSegment } from "./aligner.js";
import type { TimestampedWord, TimestampedUtterance } from "../core/types.js";
import { tokenize } from "./normalize.js";

const MIN_GAP_SEC = 0.8; // only fill gaps at least this wide
const MIN_WORDS = 1; // fill if at least this many ASR words in the gap

function normSet(text: string): Set<string> {
  return new Set(tokenize(text).map((t) => t.norm));
}

/** Index of the utterance containing time `t` (utterances sorted by start), or -1. */
function utteranceAt(utts: TimestampedUtterance[], t: number): number {
  let lo = 0;
  let hi = utts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (utts[mid]!.start <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found >= 0 && t <= utts[found]!.end ? found : -1;
}

/** ASR speaker with the most time overlapping [start, end]. */
function dominantSpeaker(
  utts: TimestampedUtterance[],
  start: number,
  end: number,
): string {
  let best = utts[0]?.speaker || "speaker_?";
  let bestOv = 0;
  for (const u of utts) {
    const ov = Math.max(0, Math.min(end, u.end) - Math.max(start, u.start));
    if (ov > bestOv) {
      bestOv = ov;
      best = u.speaker;
    }
  }
  return best;
}

export function fillAsrGaps(
  segments: AlignedSegment[],
  asrWords: TimestampedWord[],
  asrUtterances: TimestampedUtterance[],
): AlignedSegment[] {
  if (!asrWords.length) return segments;
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const utts = [...asrUtterances].sort((a, b) => a.start - b.start);

  // Uncovered ranges: before the first segment, between segments (measured against the
  // running max end, so a short segment nested inside a long one can't open a phantom
  // gap), and after the last segment. Trailing silence has no ASR words, so the trailing
  // range only ever fills real speech — e.g. a final chunk the LLM truncated.
  const ranges: Array<[number, number, AlignedSegment | undefined]> = [];
  if (!sorted.length) {
    ranges.push([0, Infinity, undefined]);
  } else {
    if (sorted[0]!.start > 0) ranges.push([0, sorted[0]!.start, sorted[0]]);
    let coveredTo = sorted[0]!.end;
    for (const next of sorted.slice(1)) {
      if (next.start > coveredTo) ranges.push([coveredTo, next.start, next]);
      coveredTo = Math.max(coveredTo, next.end);
    }
    ranges.push([coveredTo, Infinity, undefined]);
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

    // One fallback segment per ASR utterance: a long recovered range is a conversation,
    // not one speaker's monologue. Words outside any utterance stay with their neighbors.
    const runs: { words: TimestampedWord[]; utt: number }[] = [];
    for (const w of words) {
      const u = utteranceAt(utts, w.start);
      const cur = runs[runs.length - 1];
      if (cur && (u === -1 || u === cur.utt || cur.utt === -1)) {
        cur.words.push(w);
        if (cur.utt === -1) cur.utt = u;
      } else {
        runs.push({ words: [w], utt: u });
      }
    }
    for (const run of runs) {
      const first = run.words[0]!;
      const last = run.words[run.words.length - 1]!;
      filled.push({
        speaker:
          run.utt >= 0
            ? utts[run.utt]!.speaker
            : dominantSpeaker(utts, first.start, last.end),
        start: first.start,
        end: last.end,
        text: run.words.map((w) => w.text).join(" "),
        tone: [],
        confidence: 0,
        timingSource: "timestamped",
        words: run.words.map((w) => ({
          text: w.text,
          start: w.start,
          end: w.end,
          matched: true,
        })),
        sourceIndex: -1,
      });
    }
  }

  if (!filled.length) return sorted;
  return [...sorted, ...filled].sort((a, b) => a.start - b.start);
}
