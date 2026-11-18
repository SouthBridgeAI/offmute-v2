/**
 * Structured progress events for live displays (the CLI's terminal renderer, or a library
 * caller's own UI), delivered through `PipelineOptions.onProgress`.
 *
 * The pipeline still logs everything it logs; logs remain the record (plain output, the
 * watch daemon, files). These events carry what a live display needs and log lines can't
 * say cleanly: the ASR runs at the same time as the LLM, every chunk has its own state, and
 * a chunk the coverage check catches is transcribed again.
 */

/** The pipeline's stages, in the order they start. The ASR is not a stage: it runs
 * alongside `describe` and `transcribe` and reports through `asr` events. */
export type StageName =
  | "preprocess"
  | "describe"
  | "transcribe"
  | "align"
  | "speakers"
  | "identify"
  | "finalize"
  | "summary";

/** A provider a zero-storage run uses that has no way to be asked to keep nothing; its own
 * retention applies. */
export interface UnaskedProvider {
  /** The timing ASR's name ("ElevenLabs Scribe"), or a text reasoner's model ("deepseek-chat"). */
  name: string;
  /** What it gets: the audio, for word timings, or transcript text, to name speakers and
   * write the summary. */
  role: "timing" | "text";
}

/** The run's shape, known once the media is probed (before any paid call). */
export interface PlanEvent {
  type: "plan";
  durationSec: number;
  /** The transcription model. */
  model: string;
  /** The timing ASR by name ("AssemblyAI"), or "none" (the LLM's own timestamps). */
  asr: string;
  estimateUsd: number;
  /** Whether this run asks providers to keep nothing (PipelineOptions.zeroStorage). */
  zeroStorage: boolean;
  /** With zero storage, the providers this run uses that can't be asked. */
  notAsked: UnaskedProvider[];
}

/** A stage started, was satisfied from the run cache without running (`cached`), or
 * failed without stopping the run (`failed`: the summary, or every naming pass). */
export interface StageEvent {
  type: "stage";
  stage: StageName;
  state: "start" | "cached" | "failed";
  /** e.g. the reasoner model(s) naming the speakers. */
  detail?: string;
}

/** The timing ASR. `cached` means its words came from the cache (nothing billed). */
export interface AsrEvent {
  type: "asr";
  provider: string;
  state: "start" | "done" | "cached" | "failed";
  words?: number;
  speakers?: number;
  /** The language it transcribed in, when it says. */
  language?: string;
  error?: string;
}

/** How many chunks the transcribe stage will run (sent once, before the first chunk). */
export interface ChunksEvent {
  type: "chunks";
  total: number;
  chunkSec: number;
}

/** One chunk's transcription. `index` is 0-based. */
export interface ChunkEvent {
  type: "chunk";
  index: number;
  state: "running" | "done" | "cached" | "failed";
  segments?: number;
  error?: string;
}

/** The coverage check caught a chunk with too few words and transcribed it again in two
 * halves: `retrying` as that starts, then `recovered` (the halves kept) or `unchanged`. A
 * retry already in the cache sends only its outcome. */
export interface GuardEvent {
  type: "guard";
  index: number;
  /** The chunk's span in the recording (seconds). */
  startSec: number;
  endSec: number;
  state: "retrying" | "recovered" | "unchanged";
  llmWords: number;
  asrWords: number;
  /** Words in the two-half retry (with `recovered` / `unchanged`). */
  retryWords?: number;
}

/** Names the naming pass gave the voices (speaker id → name). */
export interface NamesEvent {
  type: "names";
  names: Record<string, string>;
}

/** The run finished and its outputs are written. */
export interface DoneEvent {
  type: "done";
  segments: number;
  speakers: number;
  durationSec: number;
  /** What the run cost, the summary included. */
  costUsd?: number;
  wallMs: number;
  /** Chunks the coverage check transcribed again (and kept). */
  retriedChunks: number;
  /** Every file written, as absolute paths. */
  outputs: string[];
}

export type ProgressEvent =
  | PlanEvent
  | StageEvent
  | AsrEvent
  | ChunksEvent
  | ChunkEvent
  | GuardEvent
  | NamesEvent
  | DoneEvent;

export type ProgressListener = (event: ProgressEvent) => void;

/** Calls `listener` with `event`, if there is one. A listener that throws must never fail
 * a transcription, so its errors are dropped. */
export function emitTo(
  listener: ProgressListener | undefined,
  event: ProgressEvent,
): void {
  if (!listener) return;
  try {
    listener(event);
  } catch {
    /* a display bug is not a transcription failure */
  }
}
