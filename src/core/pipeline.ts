/**
 * Pipeline orchestrator: preprocess → describe → llm-transcribe (multi-chunk,
 * concurrent) → timestamped → align → consistency → finalize → format.
 *
 * Every stage persists intermediates to disk and is resumable (skips work whose
 * output already exists unless `force`). Stoppable: results so far are always on disk.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
  ChunkQuality,
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
import { ElevenLabsClient } from "../providers/elevenlabs.js";
import { setLlmLogPath, resetLlmUsage, getLlmUsage } from "../providers/llm-log.js";
import { estimateRunCost, computeReceipt, PRICES_AS_OF } from "./pricing.js";
import { recordRun } from "./stats.js";
import { describeMeeting, type MeetingDescription } from "../transcribe/describe.js";
import {
  transcribeChunk,
  partitionByOwnership,
  type ParsedLlmSegment,
  type ChunkTranscriptionResult,
} from "../transcribe/llm-transcribe.js";
import { chunkGrounding } from "../transcribe/grounding.js";
import { chunkCoverage } from "../transcribe/coverage.js";
import { transcribeInHalves } from "./retranscribe.js";
import {
  DEGENERATE_COMPRESSION_RATIO,
  maxCompressionRatio,
} from "../transcribe/degeneration.js";
import { alignSegments, toAsrClock, type AlignedSegment } from "../align/aligner.js";
import { fillAsrGaps } from "../align/fill-gaps.js";
import { assignGlobalSpeakers } from "../diarize/consistency.js";
import { splitMixedVoiceSegments } from "../diarize/split-mixed.js";
import { identifySpeakersV2 } from "../diarize/identify2.js";
import { resolveReasoner, resolveSecondReasoner } from "../providers/reasoner.js";
import { finalizeSegments } from "../finalize/finalize.js";
import { formatSrt, formatMarkdown, formatText, formatJson } from "../finalize/format.js";
import { formatHtml } from "../finalize/html.js";
import { summarizeTranscript } from "../finalize/summary.js";
import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";

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

/** Rethrow an error with a stage tag, e.g. "[asr] fetch failed" — so a failure names
 * the part of the pipeline it came from. Original stack preserved. */
function stageTag(name: string): (err: unknown) => never {
  return (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith(`[${name}]`)) throw err;
    const e = new Error(`[${name}] ${msg}`);
    if (err instanceof Error && err.stack) e.stack = err.stack;
    throw e;
  };
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
  resetLlmUsage();
  const runStartedAt = Date.now();

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
  // Cooperative cancellation: checked at every stage and chunk boundary. Aborting mid-run
  // leaves intermediates on disk, so the next run resumes from where it stopped.
  const checkAbort = () => {
    options.signal?.throwIfAborted();
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
        "ASSEMBLYAI_API_KEY is required for the timestamped pass (or use --timestamped elevenlabs / whisper-groq)",
      );
    }
    if (tsProvider === "whisper-groq" && !keys.groq) {
      throw new Error("GROQ_API_KEY is required for --timestamped whisper-groq");
    }
    if (tsProvider === "elevenlabs" && !keys.elevenlabs) {
      throw new Error("ELEVENLABS_API_KEY is required for --timestamped elevenlabs");
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
    checkAbort();
    logger.info("=== preprocess ===");
    probeInfo = forceAll ? null : readJson<ProbeResult>(probePath);
    if (!probeInfo) {
      probeInfo = await probe(options.input).catch(stageTag("preprocess"));
      writeJson(probePath, probeInfo);
    }
    if (!existsSync(audioPath) || forceAll) {
      logger.info("extracting audio (mono 16kHz mp3)...");
      await extractAudio(options.input, audioPath, AUDIO_OPTS).catch(
        stageTag("preprocess"),
      );
    }
    if (probeInfo.hasVideo) {
      const kfDir = `${options.intermediatesDir}/keyframes`;
      if (!existsSync(kfDir) || forceAll) {
        logger.info("extracting keyframes...");
        // Keyframes are enrichment, not a requirement — degrade gracefully.
        await extractKeyframes(options.input, kfDir, options.screenshotCount).catch(
          (err) => {
            logger.warn(
              `keyframe extraction failed (continuing audio-only): ${err instanceof Error ? err.message : err}`,
            );
          },
        );
      }
    }
  } else {
    probeInfo = forceAll ? null : readJson<ProbeResult>(probePath);
  }
  if (!probeInfo) throw new Error("probe info missing (run preprocess)");
  const duration = probeInfo.duration;

  // Predictive cost: printed before any paid call, so surprises happen up front.
  const estimate = estimateRunCost({
    durationSec: duration,
    model: models.transcribe,
    reasoner: models.reasoner,
    tsProvider,
    chunkSec: options.chunkDurationSec,
    overlapSec: options.chunkOverlapSec,
    identify: options.diarizationLevel >= 3 && has(passes, "identify"),
  });
  logger.info(
    `estimated cost ~$${estimate.totalUsd.toFixed(2)}${estimate.incomplete ? " (+unpriced parts)" : ""}  [${estimate.lines.join(" · ")}]`,
  );

  // ---------- 2. TIMESTAMPED (started now; awaited after transcription) ----------
  // The ASR needs only the audio, so it runs alongside describe and the LLM chunks. That
  // hides its latency, and its words are what each chunk's coverage is checked against
  // (step 4.1) while the transcription can still be redone.
  type AsrResult = {
    utterances: TimestampedUtterance[];
    words: TimestampedWord[];
    durationSec: number;
    hasDiarization?: boolean;
  };
  const runTimestamped = async (): Promise<{ result: AsrResult | null; billed: boolean }> => {
    if (!has(passes, "timestamped") && !has(passes, "align")) {
      const cached = forceAll
        ? null
        : readJson<AsrResult>(`${options.intermediatesDir}/timestamped.json`);
      return { result: cached, billed: false };
    }
    checkAbort();
    if (tsProvider === "none") {
      logger.info("=== timestamped: none (the LLM's own timestamps are used) ===");
      return { result: null, billed: false };
    }
    if (tsProvider === "whisper-groq") {
      logger.info("=== timestamped (Groq Whisper — no diarization) ===");
      // Reuse the compact mono 16kHz mp3 from preprocess (also satisfies Groq's 25MB limit).
      if (!existsSync(audioPath)) await extractAudio(options.input, audioPath, AUDIO_OPTS);
      const groq = new WhisperGroqClient(keys.groq!);
      const result = await groq
        .transcribe(await readFile(audioPath), { language: options.language })
        .catch(stageTag("asr"));
      writeJson(`${options.intermediatesDir}/timestamped.json`, result);
      return { result, billed: true };
    }
    if (tsProvider === "elevenlabs") {
      logger.info("=== timestamped (ElevenLabs Scribe v2) ===");
      // Cache by provider and language — switching must not serve another run's clock.
      const cachePath = `${options.intermediatesDir}/timestamped-elevenlabs${options.language ? `-${options.language}` : ""}.json`;
      let result = forceAll ? null : readJson<AsrResult>(cachePath);
      let billed = false;
      if (!result) {
        const el = new ElevenLabsClient(keys.elevenlabs!);
        result = await el
          .transcribe(await readFile(audioPath), { languageCode: options.language })
          .catch(stageTag("asr"));
        billed = true;
        writeJson(cachePath, result);
      } else {
        logger.info("[elevenlabs] cache hit");
      }
      writeJson(`${options.intermediatesDir}/timestamped.json`, result);
      logger.info(
        `[elevenlabs] ${result.utterances.length} utterances, ${result.words.length} words`,
      );
      return { result, billed };
    }
    logger.info("=== timestamped (AssemblyAI) ===");
    const aai = new AssemblyAIProvider({
      apiKey: keys.assemblyai!,
      cacheDir: `${options.intermediatesDir}/assemblyai`,
      language: options.language,
    });
    const result = await aai.transcribe(audioPath).catch(stageTag("asr"));
    writeJson(`${options.intermediatesDir}/timestamped.json`, result);
    return { result, billed: !aai.lastFromCache };
  };
  const asrRun = runTimestamped();
  // Awaited after transcription. Until then this only keeps an early ASR failure from
  // surfacing as an unhandled rejection while the LLM chunks are still running.
  asrRun.catch(() => undefined);

  // ---------- 2. DESCRIBE ----------
  let description: MeetingDescription | null = null;
  if (has(passes, "describe")) {
    const descPath = `${options.intermediatesDir}/description.json`;
    description = forceAll ? null : readJson<MeetingDescription>(descPath);
    if (!description) {
      checkAbort();
      logger.info("=== describe ===");
      const client = new GeminiClient(keys.gemini!);
      // Sample beginning + middle + end (not just the opening) so speakers who only
      // appear later still make the roster. Short files use one whole-file sample.
      const sampleSpans: [number, number][] =
        duration <= 360
          ? [[0, duration]]
          : [
              [0, 150],
              [Math.max(0, duration / 2 - 60), Math.min(duration, duration / 2 + 60)],
              [Math.max(0, duration - 120), duration],
            ];
      const files: { path: string }[] = [];
      for (let i = 0; i < sampleSpans.length; i++) {
        const [s, e] = sampleSpans[i]!;
        const samplePath = `${options.intermediatesDir}/sample_${i}.mp3`;
        if (!existsSync(samplePath) || forceAll) {
          await extractChunk(audioPath, samplePath, s, e, AUDIO_OPTS);
        }
        files.push({ path: samplePath });
      }
      const audioSampleCount = files.length;
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
        audioSampleCount,
      ).catch(stageTag("describe"));
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
      // Only the audio cut moves to a nearby silence. Ownership still changes hands at the
      // previous chunk's end (planChunks' trustedStart): moving it with the cut left a
      // hole, or a doubled stretch, of up to ±10 s at every snapped seam.
      chunks = chunks.map((c) => ({
        ...c,
        start: snapToSilence(c.start, silences, Math.min(10, options.chunkOverlapSec / 2)),
      }));
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
      chunkStart: chunk.start,
      chunkEnd: chunk.end,
    })),
  });

  const llmDir = `${options.intermediatesDir}/llm`;
  let llmChunkResults: ChunkTranscriptionResult[] = [];
  // The chunk each result came from (same order). A result's segments can't say which chunk
  // it was when there are none.
  let llmChunkPlans: ChunkPlan[] = [];
  if (has(passes, "llm-transcribe")) {
    logger.info("=== llm-transcribe ===");
    let runChunks = chunks;
    if (options.onlyChunk !== undefined)
      runChunks = chunks.filter((c) => c.index === options.onlyChunk);
    logger.info(
      `${runChunks.length} chunks (${options.chunkDurationSec}s, ${options.chunkOverlapSec}s overlap)`,
    );

    const client = new GeminiClient(keys.gemini!);
    mkdirSync(llmDir, { recursive: true });

    // Live partial output: as chunks complete, keep a coarse-timed partial transcript
    // next to the final outputs. A stopped/crashed run still leaves something readable.
    const partialPath = `${options.outputDir}/${basename(options.input, ext(options.input))}.partial.md`;
    const completed: ChunkTranscriptionResult[] = [];
    const writePartial = () => {
      try {
        const segs = completed
          .flatMap((r) => r.segments)
          .sort((a, b) => a.startSec - b.startSec);
        if (segs.length === 0) return;
        const lines = segs.map((s) => {
          const mm = Math.floor(s.startSec / 60)
            .toString()
            .padStart(2, "0");
          const ss = Math.floor(s.startSec % 60)
            .toString()
            .padStart(2, "0");
          return `[${mm}:${ss}] **${s.speaker}**: ${s.text}`;
        });
        writeFileSync(
          partialPath,
          `> Partial transcript (run in progress — coarse LLM timings, speakers not yet unified)\n\n${lines.join("\n\n")}\n`,
        );
      } catch {
        /* partials are best-effort */
      }
    };

    llmChunkResults = await mapPool(runChunks, options.concurrency, async (chunk) => {
      checkAbort();
      const parsedPath = `${llmDir}/chunk_${String(chunk.index).padStart(2, "0")}_parsed.json`;
      const cached = forceAll ? null : readJson<ChunkTranscriptionResult>(parsedPath);
      if (cached && cached.segments.length > 0) {
        logger.info(`chunk ${chunk.index}: cached (${cached.segments.length} segments)`);
        completed.push(cached);
        return tagWith(cached, chunk);
      }
      const chunkPath = `${llmDir}/chunk_${String(chunk.index).padStart(2, "0")}.mp3`;
      if (!existsSync(chunkPath) || forceAll) {
        await extractChunk(audioPath, chunkPath, chunk.start, chunk.end, AUDIO_OPTS);
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
          instructions: options.instructions,
        },
        { chunkDurationSec: chunk.end - chunk.start, validationRetries: 1 },
      );
      writeJson(parsedPath, result);
      writeFileSync(
        `${llmDir}/chunk_${String(chunk.index).padStart(2, "0")}_raw.json`,
        result.raw,
      );
      completed.push(result);
      writePartial();
      return tagWith(result, chunk);
    });
    llmChunkPlans = runChunks;

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
    // Load all chunk results from disk (only if caches are valid for this input). The chunk
    // comes from the file name, not the sort position, so a missing file can't shift every
    // later chunk onto the wrong audio window.
    if (!forceAll && existsSync(llmDir)) {
      for (const f of readdirSync(llmDir).sort()) {
        const m = /^chunk_(\d+)_parsed\.json$/.exec(f);
        const plan = m ? chunks.find((c) => c.index === Number(m[1])) : undefined;
        const r = plan ? readJson<ChunkTranscriptionResult>(`${llmDir}/${f}`) : null;
        if (r && plan) {
          llmChunkResults.push(tagWith(r, plan));
          llmChunkPlans.push(plan);
        }
      }
    }
  }

  // ---------- 4. TIMESTAMPED (await) ----------
  const { result: asrResult, billed: asrBilled } = await asrRun;

  // ---------- 4.1 COVERAGE ----------
  // A chunk whose transcript holds far fewer words than the ASR heard in the same audio
  // lost speech: cut off early, a "[silence]" placeholder over conversation, or a loop. It
  // is transcribed again in two halves, and the attempt that covers more is kept. Retries
  // are cached beside the chunk, so a re-run doesn't pay twice. See coverage.ts.
  const quality: ChunkQuality[] = [];
  if (asrResult?.words.length) {
    let client: GeminiClient | undefined;
    for (let i = 0; i < llmChunkResults.length; i++) {
      const plan = llmChunkPlans[i]!;
      const where = `chunk ${plan.index} [${plan.start.toFixed(0)}-${plan.end.toFixed(0)}]s`;
      let cov = chunkCoverage(llmChunkResults[i]!.segments, asrResult.words, plan.start, plan.end);
      let status: ChunkQuality["status"] = cov.low ? "low-coverage" : "ok";
      if (cov.low) {
        const retryPath = `${llmDir}/chunk_${String(plan.index).padStart(2, "0")}_retry_parsed.json`;
        let retry = forceAll ? null : readJson<ChunkTranscriptionResult>(retryPath);
        if (!retry && has(passes, "llm-transcribe")) {
          checkAbort();
          logger.warn(
            `${where}: ${cov.llmWords} words transcribed where the ASR heard ${cov.asrWords} — transcribing it again in two halves`,
          );
          client ??= new GeminiClient(keys.gemini!);
          retry = await transcribeInHalves({
            client,
            model: models.transcribe,
            audioPath,
            chunk: plan,
            pathPrefix: `${llmDir}/chunk_${String(plan.index).padStart(2, "0")}`,
            ctx: {
              index: plan.index + 1,
              total: chunks.length,
              description: description?.description,
              roster: description?.roster,
              instructions: options.instructions,
            },
            audioOpts: AUDIO_OPTS,
          }).catch(stageTag("llm-transcribe"));
          writeJson(retryPath, retry);
        }
        if (retry) {
          const again = chunkCoverage(retry.segments, asrResult.words, plan.start, plan.end);
          logger.info(
            `${where}: the halves cover ${again.llmWords} words (${again.ratio.toFixed(2)} per ASR word, was ${cov.ratio.toFixed(2)})${again.ratio > cov.ratio ? " — kept" : " — first attempt kept"}`,
          );
          if (again.ratio > cov.ratio) {
            llmChunkResults[i] = tagWith(retry, plan);
            cov = again;
            status = again.low ? "low-coverage" : "retried";
          }
        }
      }
      quality.push({
        chunk: plan.index,
        start: plan.start,
        end: plan.end,
        status,
        llmWords: cov.llmWords,
        asrWords: cov.asrWords,
        coverage: Number.isFinite(cov.ratio) ? Number(cov.ratio.toFixed(2)) : null,
      });
    }
  }
  // A meeting in a language the ASR didn't expect comes back as a handful of words (a
  // 9-minute Korean meeting: 31 English words against 1,342 transcribed), so alignment has
  // nothing to anchor to and the LLM's own timestamps are used (aligner.ts). Good chunks
  // never exceed 1.61 transcript words per ASR word. Say so, and how to fix it.
  const whole = asrResult?.words.length
    ? chunkCoverage(
        llmChunkResults.flatMap((r) => r.segments),
        asrResult.words,
        0,
        Infinity,
      )
    : null;
  const asrMissedSpeech = !!whole && whole.llmWords >= 200 && whole.ratio > 3;
  if (asrMissedSpeech) {
    logger.warn(
      `the ASR (${tsProvider}) heard ${whole!.asrWords} words where the transcript has ${whole!.llmWords} — the recording may be in a language it didn't expect, so timings come from the LLM; re-run with --language <code> (e.g. ko, ml, hi)`,
    );
  }

  // Gather all LLM segments (absolute times already applied), then partition by chunk
  // ownership: drop segments whose center time falls in the overlap region owned by the
  // PREVIOUS chunk. This structurally guarantees every word is emitted by exactly one chunk
  // (no overlap double-printing) — the fix for the WER-inflating dedup bug — which the
  // fuzzy dedup in finalize can miss (e.g. when overlap duplicates map to different speakers).
  let allLlmSegments: ParsedLlmSegment[] = llmChunkResults.flatMap((r) => r.segments);
  // Words to time the transcript by: none when the ASR missed most of the speech (a
  // language it didn't expect), so the LLM's own timestamps stand, as the warning says.
  const timingWords = asrMissedSpeech ? [] : (asrResult?.words ?? []);
  // Ownership is decided on time, so first move each chunk's timestamps onto the ASR's
  // clock: a chunk whose clock ran early lost its opening lines as "overlap".
  allLlmSegments = toAsrClock(allLlmSegments, timingWords);
  const beforePart = allLlmSegments.length;
  allLlmSegments = partitionByOwnership(allLlmSegments);
  if (beforePart !== allLlmSegments.length) {
    logger.info(
      `ownership-partition: ${beforePart} -> ${allLlmSegments.length} (dropped ${beforePart - allLlmSegments.length} overlap duplicates)`,
    );
  }
  logger.info(`total LLM segments: ${allLlmSegments.length}`);

  // ---------- 4.5 DROP LOOPS ----------
  // A repetition loop that survived every retry ships as confident text; it is better
  // replaced by what the ASR actually heard (gap-fill below refills the range from ASR
  // words). Text the ASR can't corroborate (grounding.ts) is only flagged: a correct
  // translated or mixed-language chunk scores just as low, and refilling it from ASR would
  // replace it with wrong-language text. Recomputed from the segments (cheap) rather than
  // trusted from the cached validation, so caches written before these checks are covered.
  if (asrResult?.words.length && (has(passes, "align") || has(passes, "consistency"))) {
    const dropped = new Set<number>();
    for (let i = 0; i < llmChunkResults.length; i++) {
      const r = llmChunkResults[i]!;
      const plan = llmChunkPlans[i]!;
      const q = quality.find((x) => x.chunk === plan.index);
      const where = `chunk ${plan.index} [${plan.start.toFixed(0)}-${plan.end.toFixed(0)}]s`;
      const compression = maxCompressionRatio(r.segments.map((s) => s.text).join(" "));
      if (compression > DEGENERATE_COMPRESSION_RATIO) {
        dropped.add(plan.index);
        if (q) q.status = "dropped-loop";
        logger.warn(
          `${where}: dropping repetition-loop text (compression ratio ${compression.toFixed(1)}) — ASR will fill this range`,
        );
        continue;
      }
      const g = chunkGrounding(r.segments, asrResult.words, plan.start, plan.end);
      if (!g.grounded) {
        if (q) q.ungrounded = true;
        logger.warn(
          `${where}: only ${Math.round(g.precision * 100)}% of ${g.llmTokens} content words were also heard by the ASR — check this stretch (kept as transcribed)`,
        );
      }
    }
    if (dropped.size) {
      allLlmSegments = allLlmSegments.filter(
        (s) => s.chunkIndex === undefined || !dropped.has(s.chunkIndex),
      );
    }
  }

  // ---------- 5. ALIGN ----------
  // With no ASR (`--timestamped none`) alignment keeps each segment's own LLM timestamps.
  let aligned: AlignedSegment[] = [];
  if (has(passes, "align") && (asrResult || tsProvider === "none")) {
    logger.info("=== align ===");
    aligned = alignSegments(allLlmSegments, timingWords, { timeMarginSec: 30 });
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
  // Not from an ASR that missed most of the speech: its words would be the wrong language.
  let gapFilledWords = 0;
  if (asrResult && !asrMissedSpeech && (has(passes, "align") || has(passes, "consistency"))) {
    aligned = fillAsrGaps(aligned, asrResult.words, asrResult.utterances);
    // Only gap-fill produces "timestamped" segments (aligned.json predates this step).
    const added = aligned.filter((a) => a.timingSource === "timestamped");
    gapFilledWords = added.reduce((n, a) => n + a.words.length, 0);
    if (added.length) {
      logger.info(
        `gap-filled ${added.length} ASR fallback segment(s) (${gapFilledWords} words)`,
      );
    }
  }

  // ---------- 5.6 SPLIT MIXED-VOICE SEGMENTS ----------
  // LLM mega-segments can bundle several people's speech under one label; word-level
  // ASR timing exposes the voice boundaries, so split there before consistency votes.
  if (
    asrResult &&
    (asrResult.hasDiarization ?? true) &&
    (has(passes, "align") || has(passes, "consistency"))
  ) {
    aligned = splitMixedVoiceSegments(aligned, asrResult.utterances);
  }

  // ---------- 6. CONSISTENCY ----------
  // Without an ASR, speakers are grouped by the LLM's own labels.
  let segments = aligned;
  let speakers: TranscriptResult["speakers"] = [];
  if (has(passes, "consistency") && (asrResult || tsProvider === "none")) {
    logger.info("=== consistency ===");
    const cons = assignGlobalSpeakers(aligned, asrResult?.utterances ?? [], {
      hasDiarization: asrResult ? (asrResult.hasDiarization ?? true) : false,
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

  // Consistency's label-derived display names are HINTS, not conclusions — the
  // describe-pass roster can bind names to the wrong voices (both speakers with the
  // same accent → the LLM labels by content prior, and once shipped that's a silent
  // flip; observed live on a 2-person call). Demote them: display names reset to the
  // stable global ids, and the hints go to the identify pass for verification.
  // Names in the output come only from identify (or --speakers).
  const nameHints: Record<string, string> = {};
  for (const sp of speakers) {
    if (sp.name && sp.name !== sp.id) nameHints[sp.id] = sp.name;
  }
  segments = segments.map((s) =>
    s.speakerName !== s.speaker ? { ...s, speakerName: s.speaker } : s,
  );
  speakers = speakers.map((sp) => (sp.name !== sp.id ? { ...sp, name: sp.id } : sp));

  // ---------- 6.5 IDENTIFY (level 3) ----------
  // Decoupled from DeepSeek and from the describe pass: any reasoner-capable key works
  // (falls back to Gemini, whose key transcription already required), and a missing
  // roster just means less context — not a silently skipped pass.
  if (options.diarizationLevel >= 3 && has(passes, "identify")) {
    const reasonerA = resolveReasoner(options.reasoner ?? DEFAULT_REASONER_MODEL, keys);
    if (!reasonerA) {
      logger.warn(
        "identify: no reasoner-capable API key found (DEEPSEEK/GEMINI/OPENAI/…) — skipping speaker naming",
      );
    } else {
      const mode = options.identifyMode;
      const reasonerB =
        mode === "dual" ? resolveSecondReasoner(reasonerA.info, keys) : null;
      // Cached naming: a re-run (e.g. for another output format) reuses the verified
      // names instead of re-paying the reasoners. Cached only when it actually named
      // someone — an empty result usually means a transient failure worth retrying.
      // The cache carries its own identify config: switching --identify mode, the
      // reasoners, or --speakers invalidates just this stage, not the (expensive)
      // transcription cache (configSignature deliberately excludes these options).
      const idConfig = {
        mode,
        reasonerA: reasonerA.info.model,
        reasonerB: reasonerB?.info.model ?? null,
        knownSpeakers: options.knownSpeakers ?? [],
        // What the naming step reads. If a re-run changes the transcript (a re-transcribed
        // chunk can reorder speakers by talk time), "Speaker A" may now be the other voice,
        // and the cached names must not be applied to it.
        inputs: createHash("sha1")
          .update(JSON.stringify(segments.map((s) => [s.speaker, s.text])))
          .update(JSON.stringify(speakers.map((sp) => sp.id)))
          .digest("hex"),
      };
      const idCachePath = `${options.intermediatesDir}/identified.json`;
      const cachedId = forceAll
        ? null
        : readJson<{ nameMap?: Record<string, string>; config?: typeof idConfig }>(
            idCachePath,
          );
      const idConfigMatches =
        cachedId?.config && JSON.stringify(cachedId.config) === JSON.stringify(idConfig);
      let nameMap: Record<string, string> | null = null;
      if (
        idConfigMatches &&
        cachedId?.nameMap &&
        Object.keys(cachedId.nameMap).length > 0
      ) {
        logger.info("=== identify (cached) ===");
        nameMap = cachedId.nameMap;
      } else {
        logger.info(
          `=== identify (${reasonerA.info.model}${reasonerB ? ` + ${reasonerB.info.model} second opinion` : ""}) ===`,
        );
        checkAbort();
        const id = await identifySpeakersV2(
          {
            client: reasonerA.client,
            model: reasonerA.info.model,
            provider: reasonerA.info.provider,
          },
          reasonerB
            ? {
                client: reasonerB.client,
                model: reasonerB.info.model,
                provider: reasonerB.info.provider,
              }
            : null,
          segments.map((s) => ({ speaker: s.speaker, text: s.text })),
          speakers,
          {
            roster:
              description?.roster ??
              "(no roster available — infer from the transcript alone)",
            knownSpeakers: options.knownSpeakers,
            mode,
            nameHints,
            sourceFileName: basename(options.input),
          },
        ).catch(stageTag("identify"));
        writeJson(idCachePath, { ...id, config: idConfig });
        nameMap = id.nameMap;
      }
      logger.info(
        `identified ${Object.keys(nameMap).length} speakers: ${JSON.stringify(nameMap)}`,
      );
      const nm = nameMap;
      segments = segments.map((s) =>
        nm[s.speaker] ? { ...s, speakerName: nm[s.speaker] } : s,
      );
      speakers = speakers.map((sp) => (nm[sp.id] ? { ...sp, name: nm[sp.id] } : sp));
    }
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
  const receipt = computeReceipt(getLlmUsage(), tsProvider, duration, asrBilled);
  const wallMs = Date.now() - runStartedAt;
  const metadata: TranscriptMetadata = {
    sourceFile: options.input,
    duration,
    processedAt: new Date().toISOString(),
    models: {
      transcribe: models.transcribe,
      timestamped:
        tsProvider === "whisper-groq"
          ? "whisper-large-v3 (groq)"
          : tsProvider === "elevenlabs"
            ? "scribe-v2 (elevenlabs)"
            : tsProvider === "none"
              ? "none"
              : "assemblyai-universal-2",
    },
    passes,
    wallMs,
    cost: {
      estimatedUsd: estimate.totalUsd,
      actualUsd: receipt.totalUsd,
      pricesAsOf: PRICES_AS_OF,
      lines: receipt.lines,
      llmCalls: receipt.totals.calls,
      inputTokens: receipt.totals.inputTokens,
      outputTokens: receipt.totals.outputTokens,
    },
    ...(asrResult ? { quality: { chunks: quality, gapFilledWords, asrMissedSpeech } } : {}),
  };
  const degraded = quality.filter((q) => q.status !== "ok");
  if (degraded.length || asrMissedSpeech) {
    logger.warn(
      `quality: ${degraded.map((q) => `chunk ${q.chunk} ${q.status}`).join(", ") || "all chunks ok"}${asrMissedSpeech ? " · the ASR missed most of the speech" : ""} · ${gapFilledWords} words filled from the ASR`,
    );
  }
  const result: TranscriptResult = { segments: finalSegments, speakers, metadata };
  // The full result also lands in the cache so post-hoc tools (rename) can work
  // straight from the media path without the user having asked for --formats json.
  writeJson(`${options.intermediatesDir}/result.json`, result);

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
        formatMarkdown(result, { title: base, mdStyle: options.mdStyle }),
      );
    if (fmt === "txt")
      writeFileSync(
        `${options.outputDir}/${base}.txt`,
        formatText(result, { title: base }),
      );
    if (fmt === "html")
      writeFileSync(
        `${options.outputDir}/${base}.html`,
        formatHtml(result, { title: base }),
      );
    if (fmt === "json")
      writeFileSync(`${options.outputDir}/${base}.json`, formatJson(result));
  }

  // ---------- 9. SUMMARY (optional) ----------
  if (options.summary && finalSegments.length > 0) {
    const reasoner = resolveReasoner(options.reasoner ?? DEFAULT_REASONER_MODEL, keys);
    if (!reasoner) {
      logger.warn("summary: no reasoner-capable key — skipping");
    } else {
      logger.info(`=== summary (${reasoner.info.model}) ===`);
      try {
        const summary = await summarizeTranscript(
          reasoner.client,
          reasoner.info.model,
          result,
          options.instructions,
        );
        const base = basename(options.input, ext(options.input));
        writeFileSync(`${options.outputDir}/${base}.summary.md`, summary);
        logger.info(`summary written to ${base}.summary.md`);
      } catch (err) {
        // A failed summary must never sink a finished transcription.
        logger.warn(`summary failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  // The run completed — the coarse partial is superseded by the real outputs.
  try {
    const base = basename(options.input, ext(options.input));
    const partial = `${options.outputDir}/${base}.partial.md`;
    if (existsSync(partial)) (await import("node:fs/promises")).unlink(partial);
  } catch {
    /* best-effort */
  }
  logger.info(`outputs written to ${options.outputDir}`);

  // The receipt: what this run actually cost and how long it took.
  const mins = Math.floor(wallMs / 60000);
  const secs = Math.round((wallMs % 60000) / 1000);
  logger.info(
    `receipt: ${receipt.totals.calls} LLM calls · ${(receipt.totals.inputTokens / 1000).toFixed(0)}k in / ${(receipt.totals.outputTokens / 1000).toFixed(0)}k out · ~$${receipt.totalUsd.toFixed(2)}${receipt.incomplete ? " (+unpriced)" : ""} · ${mins ? `${mins}m` : ""}${secs}s`,
  );
  for (const line of receipt.lines) logger.info(`  ${line}`);

  // Lifetime stats (~/.offmute) — best-effort, opt out with OFFMUTE_NO_STATS=1.
  recordRun(
    {
      ts: new Date().toISOString(),
      input: basename(options.input),
      durationSec: duration,
      wallMs,
      models: metadata.models,
      segments: finalSegments.length,
      characters: finalSegments.reduce((n, s) => n + s.text.length, 0),
      speakers: speakers.length,
      llmCalls: receipt.totals.calls,
      inputTokens: receipt.totals.inputTokens,
      outputTokens: receipt.totals.outputTokens,
      costUsd: receipt.totalUsd,
    },
    receipt.perModel,
  );
  return result;
}

function ext(p: string): string {
  const i = p.lastIndexOf(".");
  return i >= 0 ? p.slice(i) : "";
}

// re-exports for the library surface
export { DEFAULT_PASSES, type Pass, type ApiKeys };
