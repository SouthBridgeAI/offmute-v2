/**
 * Core data model for offmute-v2.
 *
 * Two "tracks" get fused:
 *  - the TIMING track (from ASR): word/utterance level timestamps + candidate speaker turns.
 *  - the CONTENT track (from a multimodal LLM): clean diarized text, names, tone.
 * Alignment maps timing onto content to produce the final Transcript.
 */

// ---------------------------------------------------------------------------
// Timing track (ASR)
// ---------------------------------------------------------------------------

/** A single word with timing, as produced by an ASR provider. */
export interface TimedWord {
  text: string;
  /** seconds from start of media */
  start: number;
  /** seconds from start of media */
  end: number;
  /** ASR speaker label if diarization was on (e.g. "A", "B") */
  speaker?: string;
  /** 0..1 ASR confidence */
  confidence?: number;
}

/** An ASR utterance = a contiguous run of words by one ASR speaker. */
export interface AsrUtterance {
  text: string;
  start: number;
  end: number;
  /** ASR speaker label (e.g. "A") */
  speaker: string;
  confidence?: number;
  words?: TimedWord[];
}

/** Normalized result from any ASR provider. */
export interface AsrResult {
  provider: string;
  /** model / config used, for provenance */
  model?: string;
  words: TimedWord[];
  utterances: AsrUtterance[];
  /** distinct ASR speaker labels observed */
  speakers: string[];
  durationSeconds: number;
  language?: string;
  /** whether diarization (speaker labels) was actually available */
  diarized: boolean;
}

// ---------------------------------------------------------------------------
// Content track (LLM) — pre-alignment
// ---------------------------------------------------------------------------

/** A diarized line as emitted by the LLM for a chunk (timestamps are rough/optional). */
export interface LlmLine {
  /** speaker as the LLM sees it — a name ("Hrishi") or anonymous ("Speaker 1") */
  speaker: string;
  text: string;
  /** optional tone/emotion annotation, e.g. "hesitant", "laughing" */
  tone?: string;
  /** rough start (seconds, absolute) if the LLM provided one — NOT authoritative */
  approxStart?: number;
  approxEnd?: number;
  /** which chunk this came from */
  chunkIndex?: number;
}

// ---------------------------------------------------------------------------
// Fused output
// ---------------------------------------------------------------------------

export type TimingSource = "asr" | "llm" | "interpolated";

/** A speaker in the final transcript. */
export interface Speaker {
  /** stable internal id, e.g. "S1" */
  id: string;
  /** display label — a resolved name ("Hrishi") or "Speaker A" */
  label: string;
  /** has this reached identification level 3 (real name)? */
  named: boolean;
  /** ASR labels that map to this speaker */
  asrLabels?: string[];
  /** short description (role/appearance/voice) if inferred */
  description?: string;
}

/** The unit of the final transcript. */
export interface TranscriptSegment {
  id: number;
  /** seconds, authoritative timing after alignment */
  start: number;
  end: number;
  /** resolved speaker id (see Transcript.speakers) */
  speakerId: string;
  text: string;
  /** tone/emotion annotation if any */
  tone?: string;
  // --- provenance / quality ---
  timingSource: TimingSource;
  /** 0..1 — how confident the text↔timing alignment was for this segment */
  alignmentConfidence?: number;
}

/** A record of one LLM call, for debugging/inspection (prompt + response + usage). */
export interface LlmCallRecord {
  /** which stage made the call, e.g. "diarize", "diarize-chunk-2", "identify" */
  label?: string;
  model: string;
  /** the text portion(s) of the prompt (files are noted, not inlined) */
  promptText: string;
  /** number of non-text (file/image) parts sent */
  fileParts?: number;
  responseText: string;
  usage?: { inputTokens?: number; outputTokens?: number; thoughtsTokens?: number };
  error?: string;
}

export interface TranscriptMetadata {
  source: string;
  durationSeconds: number;
  processedAt: string;
  asrProvider?: string;
  llmModel?: string;
  userInstructions?: string;
  language?: string;
}

export interface Transcript {
  segments: TranscriptSegment[];
  speakers: Speaker[];
  metadata: TranscriptMetadata;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

export interface TimeChunk {
  index: number;
  startSeconds: number;
  endSeconds: number;
}

export interface MediaChunk extends TimeChunk {
  /** path (node) or handle to the extracted audio for this chunk */
  audioPath: string;
  /** optional keyframe image paths covering this chunk */
  keyframePaths?: string[];
}

// ---------------------------------------------------------------------------
// Media probe
// ---------------------------------------------------------------------------

export interface MediaInfo {
  durationSeconds: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  sampleRate?: number;
  channels?: number;
  sizeBytes?: number;
}
