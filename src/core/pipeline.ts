/**
 * Pipeline orchestrator: preprocess → describe → llm-transcribe (multi-chunk,
 * concurrent) → timestamped → align → consistency → finalize → format.
 *
 * Every stage persists intermediates to disk and is resumable (skips work whose
 * output already exists unless `force`). Stoppable: results so far are always on disk.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  resolveKeys,
  resolveOptions,
  planChunks,
  DEFAULT_PASSES,
  type PipelineOptions,
  type Pass,
  type ApiKeys,
} from "./config.js";
import { logger } from "../utils/logger.js";
import type { Segment, TranscriptMetadata, TranscriptResult, TimestampedWord, TimestampedUtterance } from "./types.js";
import {
  checkFfmpeg,
  probe,
  extractAudio,
  extractChunk,
  extractKeyframes,
  detectSilence,
  snapToSilence,
  type ProbeResult,
} from "../audio/ffmpeg.js";
import { GeminiClient } from "../providers/gemini.js";
import { AssemblyAIProvider } from "../providers/assemblyai.js";
import { describeMeeting, type MeetingDescription } from "../transcribe/describe.js";
import { transcribeChunk, type ParsedLlmSegment, type ChunkTranscriptionResult } from "../transcribe/llm-transcribe.js";
import { alignSegments, type AlignedSegment } from "../align/aligner.js";
import { assignGlobalSpeakers } from "../diarize/consistency.js";
import { finalizeSegments } from "../finalize/finalize.js";
import { formatSrt, formatMarkdown, formatJson } from "../finalize/format.js";
import { basename } from "node:path";

const JSON_OPTS = { encoding: "utf-8" } as const;

function readJson<T>(p: string): T | null {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, JSON_OPTS)) as T;
  } catch {
    return null;
  }
}
function writeJson(p: string, data: unknown): void {
  writeFileSync(p, JSON.stringify(data, null, 2), JSON_OPTS);
}

/** Run async tasks with a concurrency cap, preserving order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

function has(passes: Pass[], p: Pass): boolean {
  return passes.includes(p);
}

export async function transcribe(opts: PipelineOptions): Promise<TranscriptResult> {
  const options = resolveOptions(opts);
  const keys = resolveKeys(options.apiKeys);
  logger.setLevel(options.logLevel);
  mkdirSync(options.intermediatesDir, { recursive: true });
  mkdirSync(options.outputDir, { recursive: true });

  const passes = options.passes;
  const models = {
    transcribe: options.model ?? "gemini-2.5-flash",
    reasoner: options.reasoner ?? "deepseek-chat",
  };

  if (!(await checkFfmpeg())) throw new Error("ffmpeg/ffprobe not found in PATH");
  if (!keys.gemini) throw new Error("GEMINI_API_KEY (or GOOGLE_API_KEY) is required");

  // ---------- 1. PREPROCESS ----------
  let probeInfo: ProbeResult | null = null;
  const audioPath = `${options.intermediatesDir}/audio.flac`;
  if (has(passes, "preprocess")) {
    logger.info("=== preprocess ===");
    probeInfo = readJson<ProbeResult>(`${options.intermediatesDir}/probe.json`) ?? (await probe(options.input));
    writeJson(`${options.intermediatesDir}/probe.json`, probeInfo);
    if (!existsSync(audioPath) || options.force) {
      logger.info("extracting audio (mono 16kHz FLAC)...");
      await extractAudio(options.input, audioPath, { format: "flac" });
    }
    if (probeInfo.hasVideo) {
      const kfDir = `${options.intermediatesDir}/keyframes`;
      if (!existsSync(kfDir) || options.force) {
        logger.info("extracting keyframes...");
        await extractKeyframes(options.input, kfDir, options.screenshotCount);
      }
    }
  } else {
    probeInfo = readJson<ProbeResult>(`${options.intermediatesDir}/probe.json`);
  }
  if (!probeInfo) throw new Error("probe info missing (run preprocess)");
  const duration = probeInfo.duration;

  // ---------- 2. DESCRIBE ----------
  let description: MeetingDescription | null = null;
  if (has(passes, "describe")) {
    const descPath = `${options.intermediatesDir}/description.json`;
    description = options.force ? null : readJson<MeetingDescription>(descPath);
    if (!description) {
      logger.info("=== describe ===");
      const client = new GeminiClient(keys.gemini!);
      const samplePath = `${options.intermediatesDir}/sample.flac`;
      if (!existsSync(samplePath)) {
        await extractChunk(audioPath, samplePath, 0, Math.min(300, duration), { format: "flac" });
      }
      const files = [{ path: samplePath }];
      const kfDir = `${options.intermediatesDir}/keyframes`;
      if (existsSync(kfDir)) {
        for (const f of ["keyframe_000.jpg", "keyframe_001.jpg", "keyframe_002.jpg"]) {
          const p = `${kfDir}/${f}`;
          if (existsSync(p)) files.push({ path: p });
        }
      }
      description = await describeMeeting(client, models.transcribe, files, basename(options.input), options.instructions);
      writeJson(descPath, description);
      logger.info(`description: ${description.description.slice(0, 120)}...`);
    }
  } else {
    description = readJson<MeetingDescription>(`${options.intermediatesDir}/description.json`);
  }

  // ---------- 3. LLM-TRANSCRIBE (per chunk, concurrent) ----------
  let llmChunkResults: ChunkTranscriptionResult[] = [];
  if (has(passes, "llm-transcribe")) {
    logger.info("=== llm-transcribe ===");
    // Silence-aware chunk planning.
    let silences: { start: number; end: number; duration: number }[] = [];
    try {
      silences = await detectSilence(audioPath, { noiseDb: -15, minDuration: 0.3 });
      if (silences.length < 3) silences = await detectSilence(audioPath, { noiseDb: -12, minDuration: 0.25 });
    } catch {
      /* ignore */
    }
    let chunks = planChunks(duration, options.chunkDurationSec, options.chunkOverlapSec);
    if (silences.length > 3) {
      chunks = chunks.map((c) => {
        const snapped = snapToSilence(c.start, silences, Math.min(10, options.chunkOverlapSec / 2));
        return { ...c, start: snapped };
      });
    }
    if (options.onlyChunk !== undefined) chunks = chunks.filter((c) => c.index === options.onlyChunk);
    logger.info(`${chunks.length} chunks (${options.chunkDurationSec}s, ${options.chunkOverlapSec}s overlap)`);

    const client = new GeminiClient(keys.gemini!);
    const llmDir = `${options.intermediatesDir}/llm`;
    mkdirSync(llmDir, { recursive: true });

    llmChunkResults = await mapPool(chunks, options.concurrency, async (chunk) => {
      const parsedPath = `${llmDir}/chunk_${String(chunk.index).padStart(2, "0")}_parsed.json`;
      const cached = options.force ? null : readJson<ChunkTranscriptionResult>(parsedPath);
      if (cached && cached.segments.length > 0) {
        logger.info(`chunk ${chunk.index}: cached (${cached.segments.length} segments)`);
        return cached;
      }
      const chunkPath = `${llmDir}/chunk_${String(chunk.index).padStart(2, "0")}.flac`;
      if (!existsSync(chunkPath)) {
        await extractChunk(audioPath, chunkPath, chunk.start, chunk.end, { format: "flac" });
      }
      // Previous tail for continuity (best-effort: from prior chunk's cached result).
      let previousTail: string | undefined;
      if (chunk.index > 0) {
        const prev = readJson<ChunkTranscriptionResult>(
          `${llmDir}/chunk_${String(chunk.index - 1).padStart(2, "0")}_parsed.json`,
        );
        if (prev && prev.segments.length) {
          previousTail = prev.segments.slice(-6).map((s) => `${s.speaker}: ${s.text}`).join("\n");
        }
      }
      logger.info(`chunk ${chunk.index}: transcribing [${chunk.start.toFixed(0)}-${chunk.end.toFixed(0)}]s...`);
      const result = await transcribeChunk(
        client,
        models.transcribe,
        chunkPath,
        chunk.start,
        {
          index: chunk.index + 1,
          total: chunks.length,
          description: description?.description,
          roster: description?.roster,
          previousTail,
          instructions: options.instructions,
        },
        { chunkDurationSec: chunk.end - chunk.start, validationRetries: 1 },
      );
      writeJson(parsedPath, result);
      writeFileSync(`${llmDir}/chunk_${String(chunk.index).padStart(2, "0")}_raw.json`, result.raw);
      return result;
    });
  } else {
    // Load all chunk results from disk.
    const llmDir = `${options.intermediatesDir}/llm`;
    if (existsSync(llmDir)) {
      const files = await import("node:fs/promises").then((m) => m.readdir(llmDir));
      llmChunkResults = files
        .filter((f) => f.endsWith("_parsed.json"))
        .sort()
        .map((f) => readJson<ChunkTranscriptionResult>(`${llmDir}/${f}`)!)
        .filter(Boolean);
    }
  }

  // Gather all LLM segments (absolute times already applied).
  const allLlmSegments: ParsedLlmSegment[] = llmChunkResults.flatMap((r) => r.segments);
  logger.info(`total LLM segments: ${allLlmSegments.length}`);

  // ---------- 4. TIMESTAMPED ----------
  let asrResult: { utterances: TimestampedUtterance[]; words: TimestampedWord[]; durationSec: number } | null = null;
  if (has(passes, "timestamped") || has(passes, "align")) {
    logger.info("=== timestamped (AssemblyAI) ===");
    if (!keys.assemblyai) throw new Error("ASSEMBLYAI_API_KEY is required for the timestamped pass");
    const aai = new AssemblyAIProvider({ apiKey: keys.assemblyai!, cacheDir: `${options.intermediatesDir}/assemblyai` });
    asrResult = await aai.transcribe(audioPath);
    writeJson(`${options.intermediatesDir}/timestamped.json`, asrResult);
  } else {
    asrResult = readJson(`${options.intermediatesDir}/timestamped.json`);
  }

  // ---------- 5. ALIGN ----------
  let aligned: AlignedSegment[] = [];
  if (has(passes, "align") && asrResult) {
    logger.info("=== align ===");
    aligned = alignSegments(allLlmSegments, asrResult.words, { timeMarginSec: 30 });
    writeJson(`${options.intermediatesDir}/aligned.json`, aligned);
  } else {
    aligned = readJson(`${options.intermediatesDir}/aligned.json`) ?? [];
  }
  const alignedOk = aligned.filter((a) => a.timingSource !== "coarse").length;
  logger.info(`aligned: ${alignedOk}/${aligned.length} with ASR timing`);

  // ---------- 6. CONSISTENCY ----------
  let segments = aligned;
  let speakers: TranscriptResult["speakers"] = [];
  if (has(passes, "consistency") && asrResult) {
    logger.info("=== consistency ===");
    const cons = assignGlobalSpeakers(aligned, asrResult.utterances);
    segments = cons.segments;
    speakers = cons.speakers;
    writeJson(`${options.intermediatesDir}/consistent.json`, { segments, speakers });
  } else {
    const c = readJson<{ segments: AlignedSegment[]; speakers: typeof speakers }>(`${options.intermediatesDir}/consistent.json`);
    if (c) {
      segments = c.segments;
      speakers = c.speakers;
    }
  }

  // ---------- 7. FINALIZE ----------
  let finalSegments: Segment[] = [];
  if (has(passes, "finalize")) {
    logger.info("=== finalize ===");
    finalSegments = finalizeSegments(segments);
    writeJson(`${options.intermediatesDir}/final.json`, finalSegments);
  } else {
    finalSegments = readJson(`${options.intermediatesDir}/final.json`) ?? [];
  }
  logger.info(`final segments: ${finalSegments.length}`);

  // ---------- 8. FORMAT + WRITE ----------
  const metadata: TranscriptMetadata = {
    sourceFile: options.input,
    duration,
    processedAt: new Date().toISOString(),
    models: { transcribe: models.transcribe, timestamped: "assemblyai-universal-2" },
    passes,
  };
  const result: TranscriptResult = { segments: finalSegments, speakers, metadata };

  for (const fmt of options.formats) {
    const base = basename(options.input, ext(options.input));
    if (fmt === "srt") writeFileSync(`${options.outputDir}/${base}.srt`, formatSrt(result, { title: base }));
    if (fmt === "md") writeFileSync(`${options.outputDir}/${base}.md`, formatMarkdown(result, { title: base }));
    if (fmt === "json") writeFileSync(`${options.outputDir}/${base}.json`, formatJson(result));
  }
  logger.info(`outputs written to ${options.outputDir}`);
  return result;
}

function ext(p: string): string {
  const i = p.lastIndexOf(".");
  return i >= 0 ? p.slice(i) : "";
}

// re-exports for the library surface
export { DEFAULT_PASSES, type Pass, type ApiKeys };
