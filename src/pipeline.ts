/**
 * offmute-v2 pipeline orchestrator (Node).
 * probe → preprocess → ASR(timing) → diarize(LLM) → align → identify → format.
 */
import { basename, dirname, extname, join } from "node:path";
import { existsSync } from "node:fs";
import type { AsrResult, LlmCallRecord, Transcript } from "./types.js";
import { probeMedia, extractAudio, extractKeyframes } from "./media/ffmpeg.js";
import { transcribeWithAssemblyAI } from "./providers/assemblyai.js";
import { GeminiClient } from "./providers/gemini.js";
import { DIARIZATION_SYSTEM } from "./core/prompts.js";
import { buildTranscript } from "./core/assemble.js";
import { orchestrateChunks } from "./core/orchestrate.js";
import { formatSrt } from "./core/srt.js";
import { toJSON, toMarkdown, toSRT, toText } from "./core/format.js";
import { Intermediates } from "./node/intermediates.js";
import { identifySpeakersLLM } from "./core/identify.js";

export interface ProgressEvent {
  stage: string;
  message: string;
  pct?: number;
}

export interface TranscribeOptions {
  instructions?: string;
  asr?: "assemblyai" | "none";
  asrModel?: string;
  llmModel?: string;
  /** thinking level for the LLM (Gemini 3.x): MINIMAL|LOW|MEDIUM|HIGH (default MINIMAL).
   * NOTE: LOW+ can over-think on long audio and starve the output — MINIMAL is reliable. */
  llmThinkingLevel?: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
  useVideo?: boolean;
  keyframeCount?: number;
  /** split turns into display-sized cues (default true) */
  subSegment?: boolean;
  /** run the LLM speaker-identification/merge pass (default true) */
  identifySpeakers?: boolean;
  knownSpeakers?: Record<string, string>;
  intermediatesDir?: string;
  cache?: boolean;
  onProgress?: (e: ProgressEvent) => void;
  /** invoked once per LLM call with its prompt/response/usage (for inspection/debug) */
  onLlmCall?: (rec: LlmCallRecord) => void;
  /** write every LLM call (prompt + response) to intermediates/llm/ (default true) */
  logLlm?: boolean;
  /** cancel the run (cooperatively, at stage and chunk boundaries) */
  signal?: AbortSignal;
  apiKeys?: { gemini?: string; assemblyai?: string };
  /** force chunking threshold in minutes (default 35; longer files are chunked) */
  maxSinglePassMinutes?: number;
  /** chunk length in minutes when chunking (default 15) */
  chunkMinutes?: number;
  /** overlap between chunks in minutes (default 2) */
  chunkOverlapMinutes?: number;
}

export interface TranscribeResult {
  transcript: Transcript;
  srt: string;
  markdown: string;
  json: string;
  /** plain-text transcript (speaker-grouped) */
  text: string;
  intermediatesDir: string;
  asr?: AsrResult;
}

const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);

/** Run a stage, annotating any thrown error with which stage failed (e.g. "[asr] …"). */
async function stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as Error;
    if (err?.name === "AbortError") throw err; // surface cancellation as-is
    throw new Error(`[${name}] ${err?.message ?? String(e)}`, { cause: err });
  }
}

export async function transcribe(
  input: string,
  options: TranscribeOptions = {}
): Promise<TranscribeResult> {
  const {
    instructions,
    asr: asrProvider = "assemblyai",
    llmModel = "gemini-flash-latest",
    llmThinkingLevel = "MINIMAL",
    keyframeCount = 8,
    subSegment = true,
    identifySpeakers = true,
    knownSpeakers,
    cache = true,
    logLlm = true,
    onProgress,
    signal,
    apiKeys,
  } = options;

  const progress = (stage: string, message: string, pct?: number) =>
    onProgress?.({ stage, message, pct });
  // cooperative cancellation — called at stage/chunk boundaries
  const checkAbort = () => signal?.throwIfAborted();

  checkAbort();
  if (!existsSync(input)) throw new Error(`Input not found: ${input}`);

  const base = basename(input, extname(input));
  const interDir = options.intermediatesDir ?? join(dirname(input), `.offmute_${base}`);
  const inter = new Intermediates(interDir);

  // 1. Probe -------------------------------------------------------------
  progress("probe", `Probing ${basename(input)}`);
  const info = await inter.cachedJSON("media-info.json", cache, () => probeMedia(input));
  const isVideo = info.hasVideo && VIDEO_EXT.has(extname(input).toLowerCase());
  // Never attempt video work without an actual video stream (e.g. audio .m4a, even
  // if the caller/CLI passed useVideo: true).
  const useVideo = (options.useVideo ?? isVideo) && info.hasVideo;

  // 2. Preprocess audio --------------------------------------------------
  progress("preprocess", "Extracting 16k mono audio");
  const audioPath = inter.path("audio.mp3");
  if (!cache || !existsSync(audioPath)) {
    await extractAudio(input, audioPath, { sampleRate: 16000, channels: 1 });
  }

  // keyframes (video) ----------------------------------------------------
  let keyframePaths: string[] = [];
  if (useVideo && keyframeCount > 0) {
    progress("preprocess", `Extracting ${keyframeCount} keyframes`);
    const kfDir = inter.path("keyframes");
    try {
      if (!cache || !existsSync(kfDir)) {
        keyframePaths = await extractKeyframes(input, kfDir, {
          count: keyframeCount,
          durationSeconds: info.durationSeconds,
        });
      } else {
        // reuse existing
        const { readdirSync } = await import("node:fs");
        keyframePaths = readdirSync(kfDir)
          .filter((f) => f.endsWith(".jpg"))
          .sort()
          .map((f) => join(kfDir, f));
      }
    } catch (e) {
      // degrade gracefully — no usable video frames (e.g. cover-art-only stream)
      progress("preprocess", `Skipping keyframes (${(e as Error).message.slice(0, 60)})`);
      keyframePaths = [];
    }
  }

  // 3. ASR pass (timing) -------------------------------------------------
  checkAbort();
  let asr: AsrResult | undefined;
  if (asrProvider === "assemblyai") {
    progress("asr", "Transcribing for word-level timing (AssemblyAI)");
    asr = await inter.cachedJSON<AsrResult>("asr.json", cache, async () =>
      stage("asr", async () => {
      const { asr: r } = await transcribeWithAssemblyAI(audioPath, {
        apiKey: apiKeys?.assemblyai,
        speakerLabels: true,
        speechModel: options.asrModel,
      });
      return r;
      })
    );
  }

  // 4-5. Diarize (single-pass or chunked) + align -----------------------
  const gemini = new GeminiClient(apiKeys?.gemini);
  // Log every LLM call (prompt + response + usage) to intermediates/llm/ for inspection.
  let llmSeq = 0;
  gemini.onCall = (rec) => {
    options.onLlmCall?.(rec);
    if (logLlm) {
      const n = String(llmSeq++).padStart(2, "0");
      const stem = `llm/${n}-${rec.label ?? "call"}`;
      inter.writeText(`${stem}.prompt.txt`, rec.promptText + (rec.fileParts ? `\n\n[+${rec.fileParts} file part(s)]` : ""));
      inter.writeText(`${stem}.response.txt`, rec.responseText || `[error] ${rec.error ?? "unknown"}`);
      inter.writeJSON(`${stem}.meta.json`, { model: rec.model, label: rec.label, usage: rec.usage, fileParts: rec.fileParts, error: rec.error });
    }
  };
  const { segments, allTurns, voiceDist } = await orchestrateChunks({
    asr,
    durationSeconds: info.durationSeconds,
    instructions,
    subSegment,
    maxSinglePassSeconds: (options.maxSinglePassMinutes ?? 35) * 60,
    chunkSeconds: (options.chunkMinutes ?? 15) * 60,
    overlapSeconds: (options.chunkOverlapMinutes ?? 2) * 60,
    signal,
    onProgress: (msg) => progress("diarize", msg),
    // Node-specific: extract this chunk's audio, call Gemini, cache + log the raw text.
    diarizeChunk: ({ chunk, chunked, prompt }) => {
      const rawName = chunked ? `diarize_chunk_${chunk.index}.txt` : "diarize.txt";
      const label = chunked ? `diarize-chunk-${chunk.index}` : "diarize";
      return inter.cachedText(rawName, cache, () =>
        stage(label, async () => {
          let chunkAudio = audioPath;
          if (chunked) {
            chunkAudio = inter.path(`audio_chunk_${chunk.index}.mp3`);
            if (!cache || !existsSync(chunkAudio)) {
              await extractAudio(audioPath, chunkAudio, { sampleRate: 16000, channels: 1, startSeconds: chunk.startSeconds, durationSeconds: chunk.endSeconds - chunk.startSeconds });
            }
          }
          const parts = [{ filePath: chunkAudio }, ...keyframePaths.map((p) => ({ filePath: p })), { text: prompt }];
          const res = await gemini.generate(parts, {
            model: llmModel,
            temperature: 0.2,
            maxOutputTokens: 65536,
            thinkingLevel: llmThinkingLevel,
            systemInstruction: DIARIZATION_SYSTEM,
            label,
          });
          inter.writeJSON(`${rawName.replace(/\.txt$/, "")}.meta.json`, { model: res.model, usage: res.usage });
          if (!res.text.trim()) throw new Error(`Diarization returned empty text${chunked ? ` (chunk ${chunk.index})` : ""}`);
          return res.text;
        })
      );
    },
    // Node-specific: save raw→parsed + a running partial transcript (resume/inspect).
    onChunk: ({ index, chunked, turns, segmentsSoFar }) => {
      inter.writeJSON(chunked ? `diarize_chunk_${index}.parsed.json` : "diarize.parsed.json", turns);
      inter.writeText(
        "transcript.partial.srt",
        formatSrt(segmentsSoFar.map((s) => ({ start: s.start, end: s.end, speaker: s.speakerLabel, text: s.text })))
      );
    },
  });
  const turns = allTurns;

  // 6. Identify / canonicalize speakers ---------------------------------
  checkAbort();
  let resolvedNames: Record<string, string> | undefined;
  let descriptions: Record<string, string> | undefined;
  if (identifySpeakers && turns.length > 0) {
    progress("identify", "Resolving speaker identities");
    try {
      const voiceHint = Object.keys(voiceDist).length ? voiceDist : undefined;
      const ident = await inter.cachedJSON("identify.json", cache, () =>
        identifySpeakersLLM(gemini, turns, { instructions, llmModel, asrSpeakerByLabel: voiceHint })
      );
      resolvedNames = ident.resolvedNames;
      descriptions = ident.descriptions;
    } catch (e) {
      progress("identify", `Identify pass failed, using raw labels: ${(e as Error).message}`);
    }
  }

  // 7. Build Transcript --------------------------------------------------
  const transcript = buildTranscript(
    segments,
    {
      source: basename(input),
      durationSeconds: info.durationSeconds,
      processedAt: new Date().toISOString(),
      asrProvider: asr?.provider,
      llmModel,
      userInstructions: instructions,
      language: asr?.language,
    },
    { knownSpeakers, resolvedNames, descriptions }
  );

  // 8. Format + persist --------------------------------------------------
  progress("format", "Writing outputs");
  const srt = toSRT(transcript, { includeSpeaker: true });
  const markdown = toMarkdown(transcript, { title: base });
  const json = toJSON(transcript);
  const text = toText(transcript);
  inter.writeText("transcript.srt", srt);
  inter.writeText("transcript.md", markdown);
  inter.writeText("transcript.json", json);

  progress("done", `Done — ${transcript.segments.length} segments, ${transcript.speakers.length} speakers`, 100);
  return { transcript, srt, markdown, json, text, intermediatesDir: interDir, asr };
}

