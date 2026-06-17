/**
 * offmute-v2 — diarized meeting transcription.
 *
 * Public library surface. The CLI (`src/cli.ts`) and pipeline stages live in their
 * own modules; this file re-exports the stable API.
 */

export type {
  Segment,
  ChunkPlan,
  TimestampedUtterance,
  TranscriptResult,
  SpeakerInfo,
  TranscriptMetadata,
} from "./core/types.js";

// Pipeline entry point is wired up in the build phase (see TODO in core/pipeline.ts).
export { transcribe } from "./core/pipeline.js";
