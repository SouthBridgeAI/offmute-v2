/**
 * Speaker-consistency pass (diarization level 2: anonymous-but-consistent).
 *
 * The ASR diarizer (AssemblyAI) labels speakers over the WHOLE file, so its labels
 * are already globally consistent. We use them as the backbone: each aligned LLM
 * segment inherits the ASR speaker that dominates its time window. The LLM's richer
 * per-chunk labels (role/name) become display names. This gives consistent A/B/C
 * labels across chunks for free, and survives LLM label drift between chunks.
 */
import type { AlignedSegment } from "../align/aligner.js";
import type { TimestampedUtterance, SpeakerInfo } from "../core/types.js";

/** Overlap duration between [s1,e1] and [s2,e2]. */
function overlap(s1: number, e1: number, s2: number, e2: number): number {
  return Math.max(0, Math.min(e1, e2) - Math.max(s1, s2));
}

export interface ConsistencyResult {
  segments: AlignedSegment[];
  speakers: SpeakerInfo[];
  /** ASR speaker id → chosen display name. */
  displayNames: Record<string, string>;
  /** LLM label → ASR speaker id (for debugging / identification). */
  llmLabelToAsr: Record<string, string>;
}

/** Map "speaker_A" → 0, "speaker_B" → 1, … for stable ordering. */
function speakerRank(id: string): number {
  const m = id.match(/speaker_([A-Z])/);
  if (!m) return 999;
  return m[1]!.charCodeAt(0) - 65;
}

/**
 * Assign globally-consistent speaker ids to aligned segments via ASR time overlap,
 * and derive display names from the LLM labels.
 */
export function assignGlobalSpeakers(
  segments: AlignedSegment[],
  asrUtterances: TimestampedUtterance[],
): ConsistencyResult {
  // For each segment, vote by overlap duration across ASR utterances.
  const out = segments.map((seg) => ({ seg, asrSpeaker: "" }));
  const labelVotes: Record<string, Record<string, number>> = {}; // asrSpeaker -> {llmLabel: count}

  for (const o of out) {
    let bestSpeaker = "";
    let bestOverlap = 0;
    for (const u of asrUtterances) {
      const ov = overlap(o.seg.start, o.seg.end, u.start, u.end);
      if (ov > bestOverlap) {
        bestOverlap = ov;
        bestSpeaker = u.speaker;
      }
    }
    o.asrSpeaker = bestSpeaker || asrUtterances[0]?.speaker || "speaker_?";
    labelVotes[o.asrSpeaker] ??= {};
    labelVotes[o.asrSpeaker]![o.seg.speaker] =
      (labelVotes[o.asrSpeaker]![o.seg.speaker] ?? 0) + 1;
  }

  // Display name per ASR speaker = most common LLM label among its segments.
  const displayNames: Record<string, string> = {};
  for (const [asrSp, votes] of Object.entries(labelVotes)) {
    const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
    displayNames[asrSp] = best ? best[0] : asrSp;
  }

  // LLM label → dominant ASR speaker (useful for identification + merging decisions).
  const llmLabelToAsr: Record<string, string> = {};
  for (const o of out) {
    llmLabelToAsr[o.seg.speaker] = o.asrSpeaker; // last-write (segments are time-ordered)
  }

  // Relabel segments + collect speaker stats.
  const updated = out.map((o) => ({
    ...o.seg,
    speaker: o.asrSpeaker,
    speakerName: displayNames[o.asrSpeaker] || o.asrSpeaker,
  }));

  const speakerMap: Record<string, { count: number; talk: number }> = {};
  for (const s of updated) {
    speakerMap[s.speaker] ??= { count: 0, talk: 0 };
    speakerMap[s.speaker]!.count++;
    speakerMap[s.speaker]!.talk += s.end - s.start;
  }
  const speakers: SpeakerInfo[] = Object.entries(speakerMap)
    .map(([id, v]) => ({
      id,
      name: displayNames[id],
      segmentCount: v.count,
      talkTime: v.talk,
    }))
    .sort((a, b) => speakerRank(a.id) - speakerRank(b.id));

  return { segments: updated, speakers, displayNames, llmLabelToAsr };
}
