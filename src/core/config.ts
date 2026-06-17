/**
 * Configuration: model presets, API-key resolution, pipeline options.
 *
 * Security model (instr. #11): keys are read from the environment by default, but
 * every key can also be injected via the options object. Injected keys always win.
 */
import type { ChunkPlan } from "./types.js";

/** All supported provider keys. */
export interface ApiKeys {
  gemini?: string;
  google?: string; // alias for gemini
  openai?: string;
  deepseek?: string;
  groq?: string;
  assemblyai?: string;
  anthropic?: string;
}

/** Which model fills each role. */
export interface ModelAssignment {
  /** Multimodal transcription (per chunk). Needs native audio. */
  transcribe: string;
  /** Timestamped whole-file transcription. */
  timestamped: "assemblyai" | "whisper-groq" | "whisper-openai" | "gemini" | "none";
  /** Text reasoning passes (description, speaker ID, refinement). */
  reasoner: string;
}

export interface PipelineOptions {
  /** Input file path. */
  input: string;
  /** Output directory. */
  outputDir: string;
  /** Directory for intermediates (resumable). */
  intermediatesDir: string;
  /** Free-form instructions forwarded to the LLM. */
  instructions?: string;
  /** Known speaker names (skip identification, map by best effort). */
  knownSpeakers?: string[];
  /** Which passes to run. */
  passes?: Pass[];
  /** Chunk duration in seconds (LLM transcription). */
  chunkDurationSec?: number;
  /** Overlap between chunks in seconds. */
  chunkOverlapSec?: number;
  /** Number of screenshots/keyframes to extract (video). */
  screenshotCount?: number;
  /** Max concurrent chunk requests. */
  concurrency?: number;
  /** Save intermediates (default true). */
  saveIntermediates?: boolean;
  /** Output formats. */
  formats?: ("srt" | "md" | "json")[];
  /** Target diarization level. */
  diarizationLevel?: 1 | 2 | 3;
  /** Injected API keys (override env). */
  apiKeys?: ApiKeys;
  /** Override the multimodal transcription model. */
  model?: string;
  /** Override the text-reasoner model (identification pass). */
  reasoner?: string;
  /** Timestamped provider. */
  timestampedProvider?: "assemblyai" | "whisper-groq" | "none";
  /** Force reprocessing of cached chunk outputs. */
  force?: boolean;
  /** Process only a specific chunk index (debugging). */
  onlyChunk?: number;
  /** Show progress. */
  showProgress?: boolean;
  /** Log level. */
  logLevel?: "debug" | "info" | "warn" | "error";
}

export type Pass =
  | "preprocess"
  | "describe"
  | "llm-transcribe"
  | "timestamped"
  | "align"
  | "consistency"
  | "identify"
  | "finalize";

export const DEFAULT_PASSES: Pass[] = [
  "preprocess",
  "describe",
  "llm-transcribe",
  "timestamped",
  "align",
  "consistency",
  "finalize",
];

/** Model presets. Names map to provider + model strings. */
export const MODELS = {
  gemini25Pro: "gemini-2.5-pro",
  gemini25Flash: "gemini-2.5-flash",
  gemini3Pro: "gemini-3-pro-preview",
  deepseek: "deepseek-chat",
  deepseekReasoner: "deepseek-reasoner",
  gpt4o: "gpt-4o",
  claudeSonnet: "claude-sonnet-4-5",
} as const;

/** Resolve API keys: injected > env. */
export function resolveKeys(injected?: ApiKeys): ApiKeys {
  const env = process.env;
  return {
    gemini: injected?.gemini || injected?.google || env.GEMINI_API_KEY || env.GOOGLE_API_KEY,
    google: injected?.google || injected?.gemini || env.GOOGLE_API_KEY || env.GEMINI_API_KEY,
    openai: injected?.openai || env.OPENAI_API_KEY,
    deepseek: injected?.deepseek || env.DEEPSEEK_API_KEY,
    groq: injected?.groq || env.GROQ_API_KEY,
    assemblyai: injected?.assemblyai || env.ASSEMBLYAI_API_KEY,
    anthropic: injected?.anthropic || env.ANTHROPIC_API_KEY,
  };
}

/** Default options merged with user options. */
export function resolveOptions(opts: PipelineOptions): Required<
  Omit<
    PipelineOptions,
    | "instructions"
    | "knownSpeakers"
    | "onlyChunk"
    | "apiKeys"
    | "model"
    | "reasoner"
    | "timestampedProvider"
  >
> &
  Pick<
    PipelineOptions,
    | "instructions"
    | "knownSpeakers"
    | "onlyChunk"
    | "apiKeys"
    | "model"
    | "reasoner"
    | "timestampedProvider"
  > {
  return {
    input: opts.input,
    outputDir: opts.outputDir,
    intermediatesDir: opts.intermediatesDir,
    instructions: opts.instructions,
    knownSpeakers: opts.knownSpeakers,
    passes: opts.passes ?? DEFAULT_PASSES,
    chunkDurationSec: opts.chunkDurationSec ?? 600,
    chunkOverlapSec: opts.chunkOverlapSec ?? 60,
    screenshotCount: opts.screenshotCount ?? 6,
    concurrency: opts.concurrency ?? 4,
    saveIntermediates: opts.saveIntermediates ?? true,
    formats: opts.formats ?? ["srt", "md", "json"],
    diarizationLevel: opts.diarizationLevel ?? 2,
    apiKeys: opts.apiKeys,
    model: opts.model,
    reasoner: opts.reasoner,
    timestampedProvider: opts.timestampedProvider,
    force: opts.force ?? false,
    onlyChunk: opts.onlyChunk,
    showProgress: opts.showProgress ?? true,
    logLevel: opts.logLevel ?? "info",
  };
}

/** Build a chunk plan with overlap + trustedStart (for clean dedup). */
export function planChunks(
  totalDuration: number,
  chunkDuration: number,
  overlap: number,
): ChunkPlan[] {
  const chunks: ChunkPlan[] = [];
  const step = chunkDuration - overlap;
  if (step <= 0) throw new Error("chunkOverlap must be < chunkDuration");
  let start = 0;
  let index = 0;
  while (start < totalDuration) {
    const end = Math.min(start + chunkDuration, totalDuration);
    const overlapWithPrevious = index === 0 ? 0 : Math.min(overlap, end - start);
    // If the last chunk would be very short, merge into previous.
    if (end === totalDuration && end - start < chunkDuration / 3 && chunks.length > 0) {
      chunks[chunks.length - 1]!.end = end;
      break;
    }
    chunks.push({
      index,
      start,
      end,
      overlapWithPrevious,
      trustedStart: start + overlapWithPrevious,
    });
    start = end - overlap;
    if (start >= totalDuration) break;
    index++;
  }
  return chunks;
}
