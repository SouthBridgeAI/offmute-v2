/**
 * Configuration: model presets, API-key resolution, pipeline options.
 *
 * Security model (instr. #11): keys are read from the environment by default, but
 * every key can also be injected via the options object. Injected keys always win.
 */
import type { ChunkPlan } from "./types.js";
import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { statSync } from "node:fs";

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
  /** Directory for intermediates (resumable). If omitted, derived per-input so
   * different files never share a cache (see deriveIntermediatesDir). */
  intermediatesDir?: string;
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
  /** Log every LLM call (prompt+response+usage+timing) to <intermediates>/llm-calls.jsonl. */
  llmLog?: boolean;
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

/** Default model for each role (used when --model/--reasoner not passed). */
export const DEFAULT_TRANSCRIBE_MODEL = MODELS.gemini25Flash;
export const DEFAULT_REASONER_MODEL = MODELS.deepseek;

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
    intermediatesDir: opts.intermediatesDir ?? deriveIntermediatesDir(opts.input),
    instructions: opts.instructions,
    knownSpeakers: opts.knownSpeakers,
    passes: (() => {
      const p = opts.passes ?? DEFAULT_PASSES;
      // --level 3 implies the identify pass; --level <=2 strips it.
      if ((opts.diarizationLevel ?? 2) >= 3 && !p.includes("identify")) {
        // insert identify before finalize
        const out = [...p];
        const fi = out.indexOf("finalize");
        if (fi >= 0) out.splice(fi, 0, "identify");
        else out.push("identify");
        return out;
      }
      return p;
    })(),
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
    llmLog: opts.llmLog ?? true,
    logLevel: opts.logLevel ?? "info",
  };
}

/**
 * Derive a per-input intermediates directory so different input files never share a
 * cache. Anchored to the INPUT FILE's directory (not the current working directory),
 * so the location is stable regardless of where the tool is run from — e.g.
 * `/path/to/.offmute-v2-vmeeting-a1b2c3d4`. Pass `-i` to override.
 */
export function deriveIntermediatesDir(input: string): string {
  const abs = resolve(input);
  const hash = createHash("sha1").update(abs).digest("hex").slice(0, 8);
  const base = basename(input, extOf(input)) || "input";
  return `${dirname(abs)}/.offmute-v2-${base}-${hash}`;
}

function extOf(p: string): string {
  const i = p.lastIndexOf(".");
  return i >= 0 ? p.slice(i) : "";
}

/**
 * A cheap, stable signature of the input file identity (absolute path + size + mtime).
 * Used to detect when the file at a given path has changed (or a different file now sits
 * there) so cached intermediates are invalidated automatically. Uses size+mtime rather
 * than a content hash to avoid hashing multi-GB files.
 */
export function inputSignature(input: string): string {
  let size = 0;
  let mtime = 0;
  try {
    const st = statSync(input);
    size = st.size;
    mtime = Math.floor(st.mtimeMs);
  } catch {
    /* missing file — signature still includes path */
  }
  return createHash("sha1").update(`${resolve(input)}|${size}|${mtime}`).digest("hex");
}

/**
 * Signature of the options that affect the *contents* of cached intermediates. If any of
 * these change between runs (e.g. a different `--model`, chunking, instructions, or
 * timestamped provider), the cache must be invalidated — otherwise a run would silently
 * serve the previous config's output (e.g. switching to a `pro` model but getting the
 * `flash` transcript back). Options that don't affect intermediates (formats, outputDir,
 * concurrency, logging) are deliberately excluded so they don't trigger needless reruns.
 */
export function configSignature(o: PipelineOptions): string {
  const relevant = {
    model: o.model ?? DEFAULT_TRANSCRIBE_MODEL,
    reasoner: o.reasoner ?? DEFAULT_REASONER_MODEL,
    instructions: o.instructions ?? "",
    knownSpeakers: o.knownSpeakers ?? [],
    chunkDurationSec: o.chunkDurationSec ?? 600,
    chunkOverlapSec: o.chunkOverlapSec ?? 60,
    screenshotCount: o.screenshotCount ?? 6,
    diarizationLevel: o.diarizationLevel ?? 2,
    timestampedProvider: o.timestampedProvider ?? "assemblyai",
  };
  return createHash("sha1").update(JSON.stringify(relevant)).digest("hex");
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
