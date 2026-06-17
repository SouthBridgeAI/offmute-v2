/**
 * offmute-v2 — diarized meeting transcription.
 *
 * Public library surface: the high-level `transcribe` pipeline plus the individual
 * stages (for callers that want granular control, e.g. aligning an existing LLM
 * transcript to an existing ASR transcript). The CLI is in `src/cli.ts`; the browser
 * entry is `offmute-v2/browser`.
 */

export type {
  Segment,
  ChunkPlan,
  TimestampedWord,
  TimestampedUtterance,
  TranscriptResult,
  SpeakerInfo,
  TranscriptMetadata,
} from "./core/types.js";

export { transcribe } from "./core/pipeline.js";
export type { PipelineOptions, Pass, ApiKeys } from "./core/config.js";
export { planChunks } from "./core/config.js";

// Individual stages (pure logic, reusable).
export { alignSegments } from "./align/aligner.js";
export type { AlignedSegment } from "./align/aligner.js";
export { assignGlobalSpeakers } from "./diarize/consistency.js";
export { identifySpeakers } from "./diarize/identify.js";
export { finalizeSegments } from "./finalize/finalize.js";
export { formatSrt, formatMarkdown, formatJson } from "./finalize/format.js";
export { parseSrt } from "./utils/srt.js";
