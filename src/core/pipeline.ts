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
  inputSignature,
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
import { WhisperGroqClient } from "../providers/whisper-groq.js";
import { describeMeeting, type MeetingDescription } from "../transcribe/describe.js";
import { transcribeChunk, type ParsedLlmSegment, type ChunkTranscriptionResult } from "../transcribe/llm-transcribe.js";
import { alignSegments, type AlignedSegment } from "../align/aligner.js";
import { fillAsrGaps } from "../align/fill-gaps.js";
import { assignGlobalSpeakers } from "../diarize/consistency.js";
import { identifySpeakers } from "../diarize/identify.js";
import { OpenAICompatClient } from "../providers/openai-compat.js";
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

  // Early validation (the "nice check at the beginning"): input must exist before we
  // do anything, and we create both working directories up front so we never die late
  // on a missing output/intermediates dir.
  if (!existsSync(options.input)) {
    throw new Error(`Input file not found: ${options.input}`);
  }
  mkdirSync(options.intermediatesDir, { recursive: true });
  mkdirSync(options.outputDir, { recursive: true });

  // Input-identity manifest: if the file at this path changed (different size/mtime, or
  // a different file now occupies the path), invalidate ALL caches automatically. This
  // is what prevents a new input from reusing a previous file's intermediates.
  const sourcePath = `${options.intermediatesDir}/source.json`;
  const sig = inputSignature(options.input);
  const prevSig = readJson<{ signature?: string; input?: string }>(sourcePath);
  const inputChanged = !prevSig || prevSig.signature !== sig;
  if (inputChanged && prevSig) {
    logger.warn(
      `input file changed since last run (was ${prevSig.input ?? "?"}) — discarding cached intermediates`,
    );
  }
  const forceAll = options.force || inputChanged;
  writeJson(sourcePath, { input: options.input, signature: sig, updatedAt: new Date().toISOString() });

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
  const probePath = `${options.intermediatesDir}/probe.json`;
  if (has(passes, "preprocess")) {
    logger.info("=== preprocess ===");
    probeInfo = forceAll ? null : readJson<ProbeResult>(probePath);
    if (!probeInfo) {
      probeInfo = await probe(options.input);
      writeJson(probePath, probeInfo);
    }
    if (!existsSync(audioPath) || forceAll) {
      logger.info("extracting audio (mono 16kHz FLAC)...");
      await extractAudio(options.input, audioPath, { format: "flac" });
    }
    if (probeInfo.hasVideo) {
      const kfDir = `${options.intermediatesDir}/keyframes`;
      if (!existsSync(kfDir) || forceAll) {
        logger.info("extracting keyframes...");
        await extractKeyframes(options.input, kfDir, options.screenshotCount);
      }
    }
  } else {
    probeInfo = forceAll ? null : readJson<ProbeResult>(probePath);
  }
  if (!probeInfo) throw new Error("probe info missing (run preprocess)");
  const duration = probeInfo.duration;

  // ---------- 2. DESCRIBE ----------
  let description: MeetingDescription | null = null;
  if (has(passes, "describe")) {
    const descPath = `${options.intermediatesDir}/description.json`;
    description = forceAll ? null : readJson<MeetingDescription>(descPath);
    if (!description) {
      logger.info("=== describe ===");
      const client = new GeminiClient(keys.gemini!);
      const samplePath = `${options.intermediatesDir}/sample.flac`;
      if (!existsSync(samplePath) || forceAll) {
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
    description = forceAll ? null : readJson<MeetingDescription>(`${options.intermediatesDir}/description.json`);
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
      const cached = forceAll ? null : readJson<ChunkTranscriptionResult>(parsedPath);
      if (cached && cached.segments.length > 0) {
        logger.info(`chunk ${chunk.index}: cached (${cached.segments.length} segments)`);
        return cached;
      }
      const chunkPath = `${llmDir}/chunk_${String(chunk.index).padStart(2, "0")}.flac`;
      if (!existsSync(chunkPath) || forceAll) {
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
    // Load all chunk results from disk (only if caches are valid for this input).
    const llmDir = `${options.intermediatesDir}/llm`;
    if (!forceAll && existsSync(llmDir)) {
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
  let asrResult: {
    utterances: TimestampedUtterance[];
    words: TimestampedWord[];
    durationSec: number;
    hasDiarization?: boolean;
  } | null = null;
  if (has(passes, "timestamped") || has(passes, "align")) {
    const provider = options.timestampedProvider ?? "assemblyai";
    if (provider === "whisper-groq") {
      logger.info("=== timestamped (Groq Whisper — no diarization) ===");
      if (!keys.groq) throw new Error("GROQ_API_KEY is required for whisper-groq");
      // Groq's 25MB limit: use a compressed mono mp3.
      const mp3Path = `${options.intermediatesDir}/audio.mp3`;
      if (!existsSync(mp3Path) || options.force) {
        await extractAudio(options.input, mp3Path, { format: "mp3", bitrate: "64k" });
      }
      const { readFile } = await import("node:fs/promises");
      const buf = await readFile(mp3Path);
      const groq = new WhisperGroqClient(keys.groq!);
      asrResult = await groq.transcribe(buf);
      writeJson(`${options.intermediatesDir}/timestamped.json`, asrResult);
    } else {
      logger.info("=== timestamped (AssemblyAI) ===");
      if (!keys.assemblyai) throw new Error("ASSEMBLYAI_API_KEY is required for the timestamped pass (or use --timestamped whisper-groq)");
      const aai = new AssemblyAIProvider({ apiKey: keys.assemblyai!, cacheDir: `${options.intermediatesDir}/assemblyai` });
      asrResult = await aai.transcribe(audioPath);
      writeJson(`${options.intermediatesDir}/timestamped.json`, asrResult);
    }
  } else {
    asrResult = forceAll ? null : readJson(`${options.intermediatesDir}/timestamped.json`);
  }

  // ---------- 5. ALIGN ----------
  let aligned: AlignedSegment[] = [];
  if (has(passes, "align") && asrResult) {
    logger.info("=== align ===");
    aligned = alignSegments(allLlmSegments, asrResult.words, { timeMarginSec: 30 });
    writeJson(`${options.intermediatesDir}/aligned.json`, aligned);
  } else {
    aligned = (forceAll ? null : readJson<AlignedSegment[]>(`${options.intermediatesDir}/aligned.json`)) ?? [];
  }
  const alignedOk = aligned.filter((a) => a.timingSource !== "coarse").length;
  logger.info(`aligned: ${alignedOk}/${aligned.length} with ASR timing`);

  // ---------- 5.5 GAP-FILL ----------
  // Recover content the LLM dropped: insert ASR fallback segments for uncovered speech.
  if (asrResult && (has(passes, "align") || has(passes, "consistency"))) {
    const before = aligned.length;
    aligned = fillAsrGaps(aligned, asrResult.words, asrResult.utterances);
    const added = aligned.length - before;
    if (added) logger.info(`gap-filled ${added} ASR fallback segment(s)`);
  }

  // ---------- 6. CONSISTENCY ----------
  let segments = aligned;
  let speakers: TranscriptResult["speakers"] = [];
  if (has(passes, "consistency") && asrResult) {
    logger.info("=== consistency ===");
    const cons = assignGlobalSpeakers(aligned, asrResult.utterances, {
      hasDiarization: asrResult.hasDiarization ?? true,
    });
    segments = cons.segments;
    speakers = cons.speakers;
    writeJson(`${options.intermediatesDir}/consistent.json`, { segments, speakers });
  } else {
    const c = forceAll
      ? null
      : readJson<{ segments: AlignedSegment[]; speakers: typeof speakers }>(
          `${options.intermediatesDir}/consistent.json`,
        );
    if (c) {
      segments = c.segments;
      speakers = c.speakers;
    }
  }

  // ---------- 6.5 IDENTIFY (level 3) ----------
  if (
    options.diarizationLevel >= 3 &&
    has(passes, "identify") &&
    keys.deepseek &&
    description
  ) {
    logger.info("=== identify (DeepSeek) ===");
    const dsClient = OpenAICompatClient.fromProvider("deepseek", keys.deepseek, models.reasoner);
    const id = await identifySpeakers(
      dsClient,
      models.reasoner,
      segments.map((s) => ({ speaker: s.speaker, text: s.text })),
      speakers,
      description.roster,
      options.knownSpeakers,
    );
    logger.info(`identified ${Object.keys(id.nameMap).length} speakers: ${JSON.stringify(id.nameMap)}`);
    writeJson(`${options.intermediatesDir}/identified.json`, id);
    segments = segments.map((s) =>
      id.nameMap[s.speaker] ? { ...s, speakerName: id.nameMap[s.speaker] } : s,
    );
    speakers = speakers.map((sp) =>
      id.nameMap[sp.id] ? { ...sp, name: id.nameMap[sp.id] } : sp,
    );
  }

  // ---------- 7. FINALIZE ----------
  let finalSegments: Segment[] = [];
  if (has(passes, "finalize")) {
    logger.info("=== finalize ===");
    finalSegments = finalizeSegments(segments);
    writeJson(`${options.intermediatesDir}/final.json`, finalSegments);
  } else {
    finalSegments = (forceAll ? null : readJson<Segment[]>(`${options.intermediatesDir}/final.json`)) ?? [];
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
