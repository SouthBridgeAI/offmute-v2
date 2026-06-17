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

/** A generic LLM label like "Speaker A" / "Unknown" — not safe to merge by. */
function isGenericLabel(label: string): boolean {
  return /^(speaker\s+[a-z0-9]+|unknown|audience(\s+member)?(\s+\d+)?)$/i.test(label.trim());
}

/** Assign globally-consistent speaker ids to aligned segments via ASR time overlap,
 * merging ASR speakers that the LLM consistently labels the same specific name/role
 * (handles ASR over-splitting, e.g. one presenter split into speaker_A + speaker_B).
 * Global ids "Speaker A", "Speaker B", … are assigned by total talk time. */
export function assignGlobalSpeakers(
  segments: AlignedSegment[],
  asrUtterances: TimestampedUtterance[],
  opts: { hasDiarization?: boolean } = {},
): ConsistencyResult {
  const hasDiarization = opts.hasDiarization ?? true;
  // For each segment, vote by overlap duration across ASR utterances.
  const out = segments.map((seg) => ({ seg, asrSpeaker: "" }));
  const labelVotes: Record<string, Record<string, number>> = {}; // asrSpeaker -> {llmLabel: count}

  const asrDuration: Record<string, number> = {}; // ASR speaker → talk duration (for ordering)
  for (const o of out) {
    let bestSpeaker = "";
    let bestOverlap = 0;
    if (hasDiarization) {
      for (const u of asrUtterances) {
        const ov = overlap(o.seg.start, o.seg.end, u.start, u.end);
        if (ov > bestOverlap) {
          bestOverlap = ov;
          bestSpeaker = u.speaker;
        }
      }
      if (!bestSpeaker) {
        // No time overlap (segment landed in a gap): pick the NEAREST utterance by time,
        // not utterances[0] — otherwise we'd misattribute to an unrelated speaker.
        let bestDist = Infinity;
        const segMid = (o.seg.start + o.seg.end) / 2;
        for (const u of asrUtterances) {
          const uMid = (u.start + u.end) / 2;
          const d = Math.abs(uMid - segMid);
          if (d < bestDist) {
            bestDist = d;
            bestSpeaker = u.speaker;
          }
        }
        bestSpeaker = bestSpeaker || "speaker_?";
      }
    } else {
      // ASR has no diarization (e.g. Whisper fallback): group directly by the LLM label.
      bestSpeaker = o.seg.speaker || "speaker_?";
      bestOverlap = o.seg.end - o.seg.start;
    }
    o.asrSpeaker = bestSpeaker;
    asrDuration[o.asrSpeaker] = (asrDuration[o.asrSpeaker] ?? 0) + Math.max(bestOverlap, 0.1);
    labelVotes[o.asrSpeaker] ??= {};
    labelVotes[o.asrSpeaker]![o.seg.speaker] =
      (labelVotes[o.asrSpeaker]![o.seg.speaker] ?? 0) + 1;
  }

  // Dominant LLM label per ASR speaker.
  const dominantLabel: Record<string, string> = {};
  for (const [asrSp, votes] of Object.entries(labelVotes)) {
    const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
    dominantLabel[asrSp] = best ? best[0] : asrSp;
  }

  // Merge ASR speakers that share a SPECIFIC dominant label (same person, ASR over-split).
  const asrToGroup: Record<string, string> = {};
  const groupLabel: Record<string, string> = {};
  const groupTalk: Record<string, number> = {}; // group → total talk DURATION
  for (const asrSp of Object.keys(labelVotes)) {
    const label = dominantLabel[asrSp] ?? asrSp;
    let groupId: string | undefined;
    if (!isGenericLabel(label)) {
      // Find an existing group with the same specific label.
      groupId = Object.keys(groupLabel).find((g) => groupLabel[g] === label);
    }
    if (!groupId) {
      groupId = asrSp;
      groupLabel[groupId] = label;
    }
    asrToGroup[asrSp] = groupId;
    groupTalk[groupId] = (groupTalk[groupId] ?? 0) + (asrDuration[asrSp] ?? 0);
  }

  // Assign global ids "Speaker A", "Speaker B", … by talk time (desc).
  const groupsByTalk = Object.keys(groupTalk).sort((a, b) => groupTalk[b]! - groupTalk[a]!);
  const groupToGlobal: Record<string, string> = {};
  groupsByTalk.forEach((g, i) => {
    groupToGlobal[g] = `Speaker ${String.fromCharCode(65 + i)}`;
  });

  // Display name: specific LLM label if available, else the global id.
  const displayNames: Record<string, string> = {};
  for (const g of groupsByTalk) {
    const label = groupLabel[g]!;
    displayNames[groupToGlobal[g]!] = isGenericLabel(label) ? groupToGlobal[g]! : label;
  }

  // LLM label → global speaker (for identification).
  const llmLabelToAsr: Record<string, string> = {};
  for (const o of out) {
    llmLabelToAsr[o.seg.speaker] = groupToGlobal[asrToGroup[o.asrSpeaker]!]!;
  }

  // Relabel segments.
  const updated = out.map((o) => {
    const global = groupToGlobal[asrToGroup[o.asrSpeaker]!]!;
    return {
      ...o.seg,
      speaker: global,
      speakerName: displayNames[global] || global,
    };
  });

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
    .sort((a, b) => (b.talkTime ?? 0) - (a.talkTime ?? 0));

  return { segments: updated, speakers, displayNames, llmLabelToAsr };
}
