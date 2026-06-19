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
  configSignature,
  DEFAULT_PASSES,
  DEFAULT_TRANSCRIBE_MODEL,
  DEFAULT_REASONER_MODEL,
  type PipelineOptions,
  type Pass,
  type ApiKeys,
} from "./config.js";
import { logger } from "../utils/logger.js";
import type {
  Segment,
  TranscriptMetadata,
  TranscriptResult,
  TimestampedWord,
  TimestampedUtterance,
  ChunkPlan,
} from "./types.js";
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
import { setLlmLogPath } from "../providers/llm-log.js";
import { describeMeeting, type MeetingDescription } from "../transcribe/describe.js";
import {
  transcribeChunk,
  partitionByOwnership,
  type ParsedLlmSegment,
  type ChunkTranscriptionResult,
} from "../transcribe/llm-transcribe.js";
import { alignSegments, type AlignedSegment } from "../align/aligner.js";
import { fillAsrGaps } from "../align/fill-gaps.js";
import { assignGlobalSpeakers } from "../diarize/consistency.js";
import { identifySpeakers } from "../diarize/identify.js";
import { OpenAICompatClient } from "../providers/openai-compat.js";
import { finalizeSegments } from "../finalize/finalize.js";
import { formatSrt, formatMarkdown, formatJson } from "../finalize/format.js";
import { basename, resolve } from "node:path";

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
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
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
  // Validate the one truly-required option up front with a clear message (rather than
  // crashing deep in path-resolution when called as a library without an input).
  if (!opts || typeof opts.input !== "string" || opts.input.length === 0) {
    throw new Error(
      "transcribe(options): 'input' (path to the audio/video file) is required",
    );
  }
  // outputDir is optional — it defaults to the input file's own directory (resolveOptions).

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
  // Surface where the working files live (defaults to the OS temp dir) so it's easy to open
  // — most terminals linkify the file:// URL. Pass -i to put it somewhere permanent.
  logger.info(
    `intermediates: ${resolve(options.intermediatesDir)}  (file://${resolve(options.intermediatesDir)})`,
  );
  // Log every LLM call (prompt + response + usage + timing) for validation.
  setLlmLogPath(options.llmLog ? `${options.intermediatesDir}/llm-calls.jsonl` : null);

  // Input-identity manifest: if the file at this path changed (different size/mtime, or
  // a different file now occupies the path), invalidate ALL caches automatically. This
  // is what prevents a new input from reusing a previous file's intermediates.
  // The manifest tracks both the input identity AND the config that affects intermediate
  // contents. A change in EITHER invalidates the cache — so switching `--model`, chunking,
  // instructions, etc. can never silently serve the previous config's transcript.
  const sourcePath = `${options.intermediatesDir}/source.json`;
  const sig = inputSignature(options.input);
  const cfgSig = configSignature(opts);
  const prevSig = readJson<{ signature?: string; config?: string; input?: string }>(
    sourcePath,
  );
  const inputChanged = !prevSig || prevSig.signature !== sig;
  const configChanged = !prevSig || prevSig.config !== cfgSig;
  if (inputChanged && prevSig) {
    logger.warn(
      `input file changed since last run (was ${prevSig.input ?? "?"}) — discarding cached intermediates`,
    );
  } else if (configChanged && prevSig) {
    logger.warn(
      "options changed since last run (model / chunking / instructions / provider) — discarding cached intermediates",
    );
  }
  const forceAll = options.force || inputChanged || configChanged;
  writeJson(sourcePath, {
    input: options.input,
    signature: sig,
    config: cfgSig,
    updatedAt: new Date().toISOString(),
  });

  const passes = options.passes;
  const models = {
    transcribe: options.model ?? DEFAULT_TRANSCRIBE_MODEL,
    reasoner: options.reasoner ?? DEFAULT_REASONER_MODEL,
  };

  if (!(await checkFfmpeg())) throw new Error("ffmpeg/ffprobe not found in PATH");
  if (!keys.gemini) throw new Error("GEMINI_API_KEY (or GOOGLE_API_KEY) is required");

  // Validate the timestamped-provider key up front too (before the expensive LLM pass),
  // so a missing ASSEMBLYAI_API_KEY fails in milliseconds instead of after a full
  // transcription run.
  const tsProvider = options.timestampedProvider ?? "assemblyai";
  const willTimestamp = has(passes, "timestamped") || has(passes, "align");
  if (willTimestamp) {
    if (tsProvider === "assemblyai" && !keys.assemblyai) {
      throw new Error(
        "ASSEMBLYAI_API_KEY is required for the timestamped pass (or use --timestamped whisper-groq)",
      );
    }
    if (tsProvider === "whisper-groq" && !keys.groq) {
      throw new Error("GROQ_API_KEY is required for --timestamped whisper-groq");
    }
  }

  // ---------- 1. PREPROCESS ----------
  let probeInfo: ProbeResult | null = null;
  // Intermediate audio is compact mono 16kHz mp3 (transparent for speech ASR/LLM) rather
  // than lossless FLAC — a full meeting's audio + per-chunk slices would otherwise duplicate
  // a large lossless copy of the media in the cache.
  const AUDIO_OPTS = { format: "mp3", bitrate: "64k" } as const;
  const audioPath = `${options.intermediatesDir}/audio.mp3`;
  const probePath = `${options.intermediatesDir}/probe.json`;
  if (has(passes, "preprocess")) {
    logger.info("=== preprocess ===");
    probeInfo = forceAll ? null : readJson<ProbeResult>(probePath);
    if (!probeInfo) {
      probeInfo = await probe(options.input);
      writeJson(probePath, probeInfo);
    }
    if (!existsSync(audioPath) || forceAll) {
      logger.info("extracting audio (mono 16kHz mp3)...");
      await extractAudio(options.input, audioPath, AUDIO_OPTS);
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
      const samplePath = `${options.intermediatesDir}/sample.mp3`;
      if (!existsSync(samplePath) || forceAll) {
        await extractChunk(audioPath, samplePath, 0, Math.min(300, duration), AUDIO_OPTS);
      }
      const files = [{ path: samplePath }];
      const kfDir = `${options.intermediatesDir}/keyframes`;
      if (existsSync(kfDir)) {
        for (const f of ["keyframe_000.jpg", "keyframe_001.jpg", "keyframe_002.jpg"]) {
          const p = `${kfDir}/${f}`;
          if (existsSync(p)) files.push({ path: p });
        }
      }
      description = await describeMeeting(
        client,
        models.transcribe,
        files,
        basename(options.input),
        options.instructions,
      );
      writeJson(descPath, description);
      logger.info(`description: ${description.description.slice(0, 120)}...`);
    }
  } else {
    description = forceAll
      ? null
      : readJson<MeetingDescription>(`${options.intermediatesDir}/description.json`);
  }

  // ---------- 3. LLM-TRANSCRIBE (per chunk, concurrent) ----------
  // The chunk plan is needed both for transcription and for ownership partitioning (below),
  // so compute it whenever we'll have LLM segments to process.
  const needChunks =
    has(passes, "llm-transcribe") || has(passes, "align") || has(passes, "consistency");
  let chunks: ChunkPlan[] = [];
  if (needChunks) {
    let silences: { start: number; end: number; duration: number }[] = [];
    try {
      silences = await detectSilence(audioPath, { noiseDb: -15, minDuration: 0.3 });
      if (silences.length < 3)
        silences = await detectSilence(audioPath, { noiseDb: -12, minDuration: 0.25 });
    } catch {
      /* ignore */
    }
    chunks = planChunks(duration, options.chunkDurationSec, options.chunkOverlapSec);
    if (silences.length > 3) {
      chunks = chunks.map((c) => {
        const snapped = snapToSilence(
          c.start,
          silences,
          Math.min(10, options.chunkOverlapSec / 2),
        );
        // trustedStart must follow the snapped start so ownership partitioning is correct.
        return { ...c, start: snapped, trustedStart: snapped + c.overlapWithPrevious };
      });
    }
  }

  // Tag every LLM segment with its source chunk's index + trustedStart (for ownership
  // partitioning below).
  const tagWith = (
    r: ChunkTranscriptionResult,
    chunk: ChunkPlan,
  ): ChunkTranscriptionResult => ({
    ...r,
    segments: r.segments.map((s) => ({
      ...s,
      chunkIndex: chunk.index,
      trustedStart: chunk.trustedStart,
    })),
  });

  let llmChunkResults: ChunkTranscriptionResult[] = [];
  if (has(passes, "llm-transcribe")) {
    logger.info("=== llm-transcribe ===");
    let runChunks = chunks;
    if (options.onlyChunk !== undefined)
      runChunks = chunks.filter((c) => c.index === options.onlyChunk);
    logger.info(
      `${runChunks.length} chunks (${options.chunkDurationSec}s, ${options.chunkOverlapSec}s overlap)`,
    );

    const client = new GeminiClient(keys.gemini!);
    const llmDir = `${options.intermediatesDir}/llm`;
    mkdirSync(llmDir, { recursive: true });

    llmChunkResults = await mapPool(runChunks, options.concurrency, async (chunk) => {
      const parsedPath = `${llmDir}/chunk_${String(chunk.index).padStart(2, "0")}_parsed.json`;
      const cached = forceAll ? null : readJson<ChunkTranscriptionResult>(parsedPath);
      if (cached && cached.segments.length > 0) {
        logger.info(`chunk ${chunk.index}: cached (${cached.segments.length} segments)`);
        return tagWith(cached, chunk);
      }
      const chunkPath = `${llmDir}/chunk_${String(chunk.index).padStart(2, "0")}.mp3`;
      if (!existsSync(chunkPath) || forceAll) {
        await extractChunk(audioPath, chunkPath, chunk.start, chunk.end, AUDIO_OPTS);
      }
      // Previous tail for continuity (best-effort: from prior chunk's cached result).
      let previousTail: string | undefined;
      if (chunk.index > 0) {
        const prev = readJson<ChunkTranscriptionResult>(
          `${llmDir}/chunk_${String(chunk.index - 1).padStart(2, "0")}_parsed.json`,
        );
        if (prev && prev.segments.length) {
          previousTail = prev.segments
            .slice(-6)
            .map((s) => `${s.speaker}: ${s.text}`)
            .join("\n");
        }
      }
      logger.info(
        `chunk ${chunk.index}: transcribing [${chunk.start.toFixed(0)}-${chunk.end.toFixed(0)}]s...`,
      );
      const result = await transcribeChunk(
        client,
        models.transcribe,
        chunkPath,
        chunk.start,
        {
          index: chunk.index + 1,
          total: runChunks.length,
          description: description?.description,
          roster: description?.roster,
          previousTail,
          instructions: options.instructions,
        },
        { chunkDurationSec: chunk.end - chunk.start, validationRetries: 1 },
      );
      writeJson(parsedPath, result);
      writeFileSync(
        `${llmDir}/chunk_${String(chunk.index).padStart(2, "0")}_raw.json`,
        result.raw,
      );
      return tagWith(result, chunk);
    });

    // Fail loudly if transcription produced nothing because every chunk hit an API/parse
    // error (e.g. an unknown --model 404). Without this, an errored run would silently
    // fall through to an ASR-only gap-fill and report a near-empty "success".
    const errored = llmChunkResults.filter((r) => r.error);
    const producedSegments = llmChunkResults.reduce((n, r) => n + r.segments.length, 0);
    if (
      llmChunkResults.length > 0 &&
      producedSegments === 0 &&
      errored.length === llmChunkResults.length
    ) {
      throw new Error(
        `LLM transcription failed for all ${llmChunkResults.length} chunk(s) with model "${models.transcribe}". First error: ${errored[0]!.error}`,
      );
    }
  } else {
    // Load all chunk results from disk (only if caches are valid for this input).
    const llmDir = `${options.intermediatesDir}/llm`;
    if (!forceAll && existsSync(llmDir)) {
      const files = (await import("node:fs/promises").then((m) => m.readdir(llmDir)))
        .filter((f) => f.endsWith("_parsed.json"))
        .sort();
      llmChunkResults = files
        .map((f, i) => {
          const r = readJson<ChunkTranscriptionResult>(`${llmDir}/${f}`);
          return r && chunks[i] ? tagWith(r, chunks[i]!) : r;
        })
        .filter(Boolean) as ChunkTranscriptionResult[];
    }
  }

  // Gather all LLM segments (absolute times already applied), then partition by chunk
  // ownership: drop segments whose center time falls in the overlap region owned by the
  // PREVIOUS chunk. This structurally guarantees every word is emitted by exactly one chunk
  // (no overlap double-printing) — the fix for the WER-inflating dedup bug — which the
  // fuzzy dedup in finalize can miss (e.g. when overlap duplicates map to different speakers).
  let allLlmSegments: ParsedLlmSegment[] = llmChunkResults.flatMap((r) => r.segments);
  const beforePart = allLlmSegments.length;
  allLlmSegments = partitionByOwnership(allLlmSegments);
  if (beforePart !== allLlmSegments.length) {
    logger.info(
      `ownership-partition: ${beforePart} -> ${allLlmSegments.length} (dropped ${beforePart - allLlmSegments.length} overlap duplicates)`,
    );
  }
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
      // Reuse the compact mono 16kHz mp3 from preprocess (also satisfies Groq's 25MB limit).
      if (!existsSync(audioPath) || forceAll) {
        await extractAudio(options.input, audioPath, AUDIO_OPTS);
      }
      const { readFile } = await import("node:fs/promises");
      const buf = await readFile(audioPath);
      const groq = new WhisperGroqClient(keys.groq!);
      asrResult = await groq.transcribe(buf);
      writeJson(`${options.intermediatesDir}/timestamped.json`, asrResult);
    } else {
      logger.info("=== timestamped (AssemblyAI) ===");
      if (!keys.assemblyai)
        throw new Error(
          "ASSEMBLYAI_API_KEY is required for the timestamped pass (or use --timestamped whisper-groq)",
        );
      const aai = new AssemblyAIProvider({
        apiKey: keys.assemblyai!,
        cacheDir: `${options.intermediatesDir}/assemblyai`,
      });
      asrResult = await aai.transcribe(audioPath);
      writeJson(`${options.intermediatesDir}/timestamped.json`, asrResult);
    }
  } else {
    asrResult = forceAll
      ? null
      : readJson(`${options.intermediatesDir}/timestamped.json`);
  }

  // ---------- 5. ALIGN ----------
  let aligned: AlignedSegment[] = [];
  if (has(passes, "align") && asrResult) {
    logger.info("=== align ===");
    aligned = alignSegments(allLlmSegments, asrResult.words, { timeMarginSec: 30 });
    writeJson(`${options.intermediatesDir}/aligned.json`, aligned);
  } else {
    aligned =
      (forceAll
        ? null
        : readJson<AlignedSegment[]>(`${options.intermediatesDir}/aligned.json`)) ?? [];
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
    const dsClient = OpenAICompatClient.fromProvider(
      "deepseek",
      keys.deepseek,
      models.reasoner,
    );
    const id = await identifySpeakers(
      dsClient,
      models.reasoner,
      segments.map((s) => ({ speaker: s.speaker, text: s.text })),
      speakers,
      description.roster,
      options.knownSpeakers,
    );
    logger.info(
      `identified ${Object.keys(id.nameMap).length} speakers: ${JSON.stringify(id.nameMap)}`,
    );
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
    finalSegments =
      (forceAll ? null : readJson<Segment[]>(`${options.intermediatesDir}/final.json`)) ??
      [];
  }
  logger.info(`final segments: ${finalSegments.length}`);

  // ---------- 8. FORMAT + WRITE ----------
  const metadata: TranscriptMetadata = {
    sourceFile: options.input,
    duration,
    processedAt: new Date().toISOString(),
    models: {
      transcribe: models.transcribe,
      timestamped:
        tsProvider === "whisper-groq"
          ? "whisper-large-v3 (groq)"
          : tsProvider === "none"
            ? "none"
            : "assemblyai-universal-2",
    },
    passes,
  };
  const result: TranscriptResult = { segments: finalSegments, speakers, metadata };

  for (const fmt of options.formats) {
    const base = basename(options.input, ext(options.input));
    if (fmt === "srt")
      writeFileSync(
        `${options.outputDir}/${base}.srt`,
        formatSrt(result, { title: base }),
      );
    if (fmt === "md")
      writeFileSync(
        `${options.outputDir}/${base}.md`,
        formatMarkdown(result, { title: base }),
      );
    if (fmt === "json")
      writeFileSync(`${options.outputDir}/${base}.json`, formatJson(result));
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
