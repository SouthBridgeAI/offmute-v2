/**
 * Pure fusion core (browser-safe): turn LLM diarized turns + ASR word timings into
 * a finished Transcript. Factored out of the Node pipeline so the same logic runs in
 * the browser. Does NOT call any provider — alignment, segmentation, speaker building.
 */
import type { AsrResult, LlmLine, TimedWord, Transcript, TranscriptMetadata, TranscriptSegment } from "../types.js";
import { alignLlmToAsr, asrSpeakerByLabel, buildSegmentsFromTokens, fillTokenTimes } from "./align.js";
import { buildSpeakers } from "./speakers.js";

export interface PlainSegment {
  start: number;
  end: number;
  speakerLabel: string;
  tone?: string;
  text: string;
  matchRatio: number;
}

/**
 * Align a list of LLM turns to ASR words (or fall back to the LLM's coarse
 * timestamps when no ASR words are given) and produce flat timed segments plus a
 * per-label ASR-voice distribution (for downstream speaker identification).
 */
export function alignTurnsToSegments(
  turns: LlmLine[],
  asrWords: TimedWord[] | undefined,
  totalDuration: number,
  subSegment: boolean
): { segments: PlainSegment[]; voiceDist: Record<string, Record<string, number>> } {
  if (!asrWords || asrWords.length === 0) {
    // no timing track: use the LLM's approxStart, interpolating ends from the next turn
    const segments = turns.map((t, i) => {
      const start = t.approxStart ?? 0;
      const end = turns[i + 1]?.approxStart ?? totalDuration;
      return {
        start,
        end: Math.max(start, end),
        speakerLabel: t.speaker,
        tone: t.tone,
        text: t.text,
        matchRatio: 0,
      };
    });
    return { segments, voiceDist: {} };
  }

  const tokens = alignLlmToAsr(turns, asrWords);
  fillTokenTimes(tokens, totalDuration);
  const voiceDist = asrSpeakerByLabel(tokens, turns.map((t) => t.speaker));
  const aligned = buildSegmentsFromTokens(turns, tokens, { subSegment });

  const segments: PlainSegment[] = [];
  const toneSeen = new Set<number>();
  for (const s of aligned) {
    // Drop only SHORT word-less segments (applause/laughter/noise annotations).
    // Keep substantial zero-match turns — real speech the ASR missed (quiet,
    // overlapping, near a chunk edge). They carry interpolated times and
    // matchRatio 0 so downstream can flag them as low-confidence.
    if (s.matchedTokens === 0 && s.tokenCount <= 3) continue;
    const turn = turns[s.turnIndex]!;
    const firstOfTurn = !toneSeen.has(s.turnIndex);
    toneSeen.add(s.turnIndex);
    segments.push({
      start: s.start,
      end: s.end,
      speakerLabel: turn.speaker,
      tone: firstOfTurn ? turn.tone : undefined,
      text: s.text,
      matchRatio: s.matchRatio,
    });
  }
  return { segments, voiceDist };
}

export interface AssembleOptions {
  knownSpeakers?: Record<string, string>;
  resolvedNames?: Record<string, string>;
  descriptions?: Record<string, string>;
}

/** Build a Transcript from flat timed segments + speaker resolution. */
export function buildTranscript(
  segments: PlainSegment[],
  metadata: TranscriptMetadata,
  options: AssembleOptions = {}
): Transcript {
  const { knownSpeakers, resolvedNames, descriptions } = options;
  const { speakers, labelToId } = buildSpeakers(
    segments.map((s) => s.speakerLabel),
    { knownSpeakers, resolvedNames, descriptions }
  );

  const transcriptSegments: TranscriptSegment[] = segments.map((s, i) => ({
    id: i + 1,
    start: s.start,
    end: s.end,
    speakerId: labelToId.get(s.speakerLabel) ?? s.speakerLabel,
    text: s.text,
    tone: s.tone,
    timingSource: s.matchRatio > 0 ? "asr" : "llm",
    alignmentConfidence: s.matchRatio,
  }));

  return { segments: transcriptSegments, speakers, metadata };
}

/**
 * Convenience: align + build in one call (single-window; no provider calls).
 * For browser single-pass use. `resolvedNames`/`descriptions` (from a prior identify
 * pass) can be supplied via options.
 */
export function assembleTranscript(
  input: { turns: LlmLine[]; asr?: AsrResult; durationSeconds: number },
  options: AssembleOptions = {}
): { transcript: Transcript; voiceDist: Record<string, Record<string, number>> } {
  const { turns, asr, durationSeconds } = input;
  const { segments, voiceDist } = alignTurnsToSegments(
    turns,
    asr?.words,
    durationSeconds,
    true
  );
  const metadata: TranscriptMetadata = {
    source: "browser",
    durationSeconds,
    processedAt: "",
    asrProvider: asr?.provider,
    language: asr?.language,
  };
  const transcript = buildTranscript(segments, metadata, options);
  return { transcript, voiceDist };
}
