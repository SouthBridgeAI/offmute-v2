/**
 * Mixed-voice segment splitter.
 *
 * Failure class (Gray Beetle post-mortem): the LLM sometimes emits one mega-segment
 * containing several people's speech under one label ("Oh my god, dude, I'm so happy
 * for you" embedded inside the storyteller's turn). Prompt rules reduce but don't
 * eliminate it. Post-alignment we have word-accurate times, so each word maps to an
 * ASR voice cluster — a segment whose words span 2+ clusters with substantial runs is
 * split at the cluster boundaries, and the consistency pass then votes each piece to
 * the right global speaker.
 *
 * Hysteresis: runs shorter than MIN_RUN_WORDS words AND MIN_RUN_SEC seconds fold into
 * their neighbor, so single-word diarizer flicker never shreds a segment.
 */
import type { AlignedSegment, AlignedWord } from "../align/aligner.js";
import type { TimestampedUtterance } from "../core/types.js";
import { logger } from "../utils/logger.js";

const MIN_RUN_WORDS = 5;
const MIN_RUN_SEC = 2.0;

interface Run {
  cluster: string;
  startIdx: number; // word index, inclusive
  endIdx: number; // exclusive
}

/** Map a time point to the ASR cluster whose utterance covers it (nearest on miss). */
function clusterAt(utterances: TimestampedUtterance[], t: number): string {
  let best = "";
  let bestDist = Infinity;
  for (const u of utterances) {
    if (t >= u.start && t <= u.end) return u.speaker;
    const d = t < u.start ? u.start - t : t - u.end;
    if (d < bestDist) {
      bestDist = d;
      best = u.speaker;
    }
  }
  return best;
}

/** Build cluster runs over a segment's MATCHED words (interpolated words follow later). */
function buildRuns(words: AlignedWord[], utterances: TimestampedUtterance[]): Run[] {
  const clusters: (string | null)[] = words.map((w) =>
    w.matched ? clusterAt(utterances, (w.start + w.end) / 2) : null,
  );
  // Unmatched words inherit the previous matched word's cluster (or the next one's).
  for (let i = 1; i < clusters.length; i++) {
    if (clusters[i] === null) clusters[i] = clusters[i - 1] ?? null;
  }
  for (let i = clusters.length - 2; i >= 0; i--) {
    if (clusters[i] === null) clusters[i] = clusters[i + 1] ?? null;
  }
  const runs: Run[] = [];
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i] ?? "";
    const last = runs[runs.length - 1];
    if (last && last.cluster === c) last.endIdx = i + 1;
    else runs.push({ cluster: c, startIdx: i, endIdx: i + 1 });
  }
  return runs;
}

function runSec(run: Run, words: AlignedWord[]): number {
  return words[run.endIdx - 1]!.end - words[run.startIdx]!.start;
}

/** Fold short runs (hysteresis) into their longer neighbors until stable. */
function foldShortRuns(runs: Run[], words: AlignedWord[]): Run[] {
  let out = runs;
  let changed = true;
  while (changed && out.length > 1) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const r = out[i]!;
      const nWords = r.endIdx - r.startIdx;
      if (nWords >= MIN_RUN_WORDS || runSec(r, words) >= MIN_RUN_SEC) continue;
      // Fold into the longer adjacent neighbor.
      const prev = out[i - 1];
      const next = out[i + 1];
      const target =
        prev && next
          ? prev.endIdx - prev.startIdx >= next.endIdx - next.startIdx
            ? prev
            : next
          : (prev ?? next);
      if (!target) continue;
      if (target === prev) prev.endIdx = r.endIdx;
      else next!.startIdx = r.startIdx;
      out = out.filter((_, j) => j !== i);
      changed = true;
      break;
    }
    // Merge now-adjacent same-cluster runs.
    const merged: Run[] = [];
    for (const r of out) {
      const last = merged[merged.length - 1];
      if (last && last.cluster === r.cluster) last.endIdx = r.endIdx;
      else merged.push({ ...r });
    }
    out = merged;
  }
  return out;
}

/** Split segments whose aligned words span multiple ASR voice clusters. */
export function splitMixedVoiceSegments(
  segments: AlignedSegment[],
  utterances: TimestampedUtterance[],
): AlignedSegment[] {
  if (utterances.length === 0) return segments;
  const out: AlignedSegment[] = [];
  let splits = 0;
  for (const seg of segments) {
    const matched = seg.words.filter((w) => w.matched).length;
    // Need real timing to reason about voices; short or poorly-aligned segments pass through.
    if (seg.words.length < MIN_RUN_WORDS * 2 || matched < seg.words.length * 0.4) {
      out.push(seg);
      continue;
    }
    const runs = foldShortRuns(buildRuns(seg.words, utterances), seg.words);
    if (runs.length <= 1) {
      out.push(seg);
      continue;
    }
    splits += runs.length - 1;
    // The LLM's label described the WHOLE segment; only the longest run keeps it.
    // Other runs get a cluster-scoped provisional label so the consistency vote
    // (and identify) treat them as their own voice.
    const lens = runs.map((r) => r.endIdx - r.startIdx);
    const dominantIdx = lens.indexOf(Math.max(...lens));
    runs.forEach((run, ri) => {
      const words = seg.words.slice(run.startIdx, run.endIdx);
      out.push({
        ...seg,
        start: words[0]!.start,
        end: words[words.length - 1]!.end,
        text: words.map((w) => w.text).join(" "),
        words,
        speaker: ri === dominantIdx ? seg.speaker : `Voice ${run.cluster}`,
      });
    });
  }
  if (splits > 0) {
    logger.info(
      `split ${splits} mixed-voice boundary(ies) across ${segments.length} segments`,
    );
  }
  return out.sort((a, b) => a.start - b.start);
}
