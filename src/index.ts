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
export type {
  PipelineOptions,
  Pass,
  ApiKeys,
  TimestampedProvider,
} from "./core/config.js";
export { planChunks } from "./core/config.js";
export {
  DEFAULT_TRANSCRIBE_MODEL,
  PRO_TRANSCRIBE_MODEL,
  DEFAULT_REASONER_MODEL,
} from "./core/models.js";
// Live progress, through PipelineOptions.onProgress.
export type {
  ProgressEvent,
  ProgressListener,
  StageName,
  PlanEvent,
  StageEvent,
  AsrEvent,
  ChunksEvent,
  ChunkEvent,
  GuardEvent,
  NamesEvent,
  DoneEvent,
  UnaskedProvider,
} from "./core/progress.js";

// Individual stages (pure logic, reusable).
export { alignSegments } from "./align/aligner.js";
export type { AlignedSegment } from "./align/aligner.js";
export { assignGlobalSpeakers } from "./diarize/consistency.js";
export { identifySpeakers } from "./diarize/identify.js";
export { identifySpeakersV2 } from "./diarize/identify2.js";
export type {
  ReasonerHandle,
  IdentifyV2Options,
  IdentifyV2Result,
  IdentifyV2Decision,
} from "./diarize/identify2.js";
export type { ChatClient } from "./providers/openai-compat.js";
export { finalizeSegments } from "./finalize/finalize.js";
export { formatSrt, formatMarkdown, formatText, formatJson } from "./finalize/format.js";
export { formatHtml } from "./finalize/html.js";
export { summarizeTranscript } from "./finalize/summary.js";
export { parseSrt } from "./utils/srt.js";
