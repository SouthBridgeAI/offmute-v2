/**
 * Core domain types for offmute-v2.
 *
 * The pipeline produces a timeline of {@link Segment}s, each carrying a speaker,
 * accurate start/end times, the transcribed text, and optional tone/emotion
 * annotations. Segments are the common currency between every stage.
 */

/** A single diarized, timestamped, tone-annotated span of speech. */
export interface Segment {
  /** Stable id within the final transcript (assigned at finalize time). */
  id: number;
  /** Start time in seconds (absolute, from the start of the source media). */
  start: number;
  /** End time in seconds (absolute). */
  end: number;
  /** Global, consistent speaker label, e.g. "speaker_0" or "Hrishi". */
  speaker: string;
  /** Display name for the speaker (may equal `speaker` until identification). */
  speakerName?: string;
  /** The transcribed words. */
  text: string;
  /** Free-form tone/emotion/behavior annotations, e.g. "hesitant", "laughing". */
  tone?: string[];
  /** Where the timing came from — useful for debugging alignment. */
  timingSource?: "llm" | "aligned" | "timestamped" | "interpolated";
  /** Where the text came from. */
  textSource?: "llm" | "timestamped";
  /** Which chunk produced this segment (pre-merge). */
  sourceChunk?: number;
  /** Alignment confidence in [0,1] when produced by the aligner. */
  confidence?: number;
}

/** A planned audio chunk with overlap metadata for clean deduplication. */
export interface ChunkPlan {
  index: number;
  /** Absolute start time (seconds). */
  start: number;
  /** Absolute end time (seconds). */
  end: number;
  /** The portion of this chunk that overlaps the previous chunk. */
  overlapWithPrevious: number;
  /**
   * Absolute time after which this chunk's content is "trusted" (i.e. not
   * covered by the previous chunk). Content before this point may be dropped
   * during merge to avoid double-transcription. Equals `start + overlap`.
   */
  trustedStart: number;
  /** Path to the extracted audio chunk file. */
  path?: string;
}

/** A single word with accurate timing (from a timestamped transcriber). */
export interface TimestampedWord {
  text: string;
  start: number; // seconds
  end: number; // seconds
  confidence?: number;
}

/** A speaker as understood by a timestamped diarizer (AssemblyAI/Whisper). */
export interface TimestampedUtterance {
  start: number;
  end: number;
  speaker: string;
  text: string;
  confidence?: number;
  words?: TimestampedWord[];
}

/** The full result of running the pipeline. */
export interface TranscriptResult {
  segments: Segment[];
  speakers: SpeakerInfo[];
  metadata: TranscriptMetadata;
}

export interface SpeakerInfo {
  /** Global consistent id, e.g. "speaker_0". */
  id: string;
  /** Identified name if known, else undefined. */
  name?: string;
  /** Human-readable description from the LLM description pass. */
  description?: string;
  /** Number of segments attributed to this speaker. */
  segmentCount?: number;
  /** Total speaking time in seconds. */
  talkTime?: number;
}

export interface TranscriptMetadata {
  sourceFile: string;
  duration: number;
  processedAt: string;
  models: Record<string, string>;
  passes: string[];
}
