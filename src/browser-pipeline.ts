/**
 * Browser orchestrator: ffmpeg.wasm (host-loaded) + fetch providers + the pure
 * fusion core. Mirrors the Node pipeline (preprocess → ASR → diarize → align →
 * merge → identify → format), including chunking for long media. Runs entirely in
 * the browser; keys are injected by the host.
 */
import type { AsrResult, LlmCallRecord, Transcript } from "./types.js";
import type { FFmpegLike } from "./media/ffmpeg-wasm.js";
import { extractAudioWasm, extractKeyframesWasm, writeInput } from "./media/ffmpeg-wasm.js";
import { transcribeWithAssemblyAIFetch } from "./providers/assemblyai-fetch.js";
import { GeminiFetchClient } from "./providers/gemini-fetch.js";
import { DIARIZATION_SYSTEM } from "./core/prompts.js";
import { buildTranscript } from "./core/assemble.js";
import { orchestrateChunks } from "./core/orchestrate.js";
import { identifySpeakersLLM, type TextGenerator } from "./core/identify.js";
import { toJSON, toMarkdown, toSRT } from "./core/format.js";
import { secondsToCompact } from "./core/time.js";

export interface BrowserProgress {
  stage: string;
  message: string;
}

export interface TranscribeInBrowserOptions {
  /** a loaded @ffmpeg/ffmpeg instance */
  ffmpeg: FFmpegLike;
  apiKeys: { gemini: string; assemblyai: string };
  instructions?: string;
  llmModel?: string;
  llmThinkingLevel?: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
  /** extract keyframes for visual context (input must be video) */
  useVideo?: boolean;
  keyframeCount?: number;
  subSegment?: boolean;
  identifySpeakers?: boolean;
  knownSpeakers?: Record<string, string>;
  maxSinglePassMinutes?: number;
  chunkMinutes?: number;
  chunkOverlapMinutes?: number;
  onProgress?: (e: BrowserProgress) => void;
  /** invoked once per LLM call with its prompt/response/usage (for inspection/debug) */
  onLlmCall?: (rec: LlmCallRecord) => void;
  /** cancel the run (cooperatively, at stage and chunk boundaries) */
  signal?: AbortSignal;
}

export interface BrowserTranscribeResult {
  transcript: Transcript;
  srt: string;
  markdown: string;
  json: string;
  asr: AsrResult;
}

export async function transcribeInBrowser(
  input: Blob | Uint8Array,
  options: TranscribeInBrowserOptions
): Promise<BrowserTranscribeResult> {
  const {
    ffmpeg,
    apiKeys,
    instructions,
    llmModel = "gemini-flash-latest",
    llmThinkingLevel = "MINIMAL",
    useVideo = false,
    keyframeCount = 8,
    subSegment = true,
    identifySpeakers = true,
    knownSpeakers,
    onProgress,
  } = options;
  const progress = (stage: string, message: string) => onProgress?.({ stage, message });

  const sourceBytes = input instanceof Uint8Array ? input : new Uint8Array(await input.arrayBuffer());

  // 1. preprocess: write source once, extract full 16k mono audio
  progress("preprocess", "Decoding audio (ffmpeg.wasm)");
  const sourceName = await writeInput(ffmpeg, sourceBytes, "__offmute_source");
  const fullAudio = await extractAudioWasm(ffmpeg, null, { inputName: sourceName, keepInput: true });
  const fullAudioName = await writeInput(ffmpeg, fullAudio, "__offmute_audio.mp3");

  // 2. ASR (gives duration + word timing)
  progress("asr", "Transcribing for timing (AssemblyAI)");
  const { asr } = await transcribeWithAssemblyAIFetch(fullAudio, { apiKey: apiKeys.assemblyai, speakerLabels: true });
  const duration = asr.durationSeconds;

  // 3. keyframes (video only)
  let keyframes: Uint8Array[] = [];
  if (useVideo && keyframeCount > 0) {
    progress("preprocess", `Extracting ${keyframeCount} keyframes`);
    const atSeconds = Array.from({ length: keyframeCount }, (_, i) => Math.max(0.5, ((i + 0.5) / keyframeCount) * duration));
    try {
      keyframes = await extractKeyframesWasm(ffmpeg, null, { inputName: sourceName, atSeconds });
    } catch {
      keyframes = []; // input may be audio-only
    }
  }

  // 4-5-6. diarize + align + merge — shared orchestrator (same as Node) -----
  const gem = new GeminiFetchClient(apiKeys.gemini);
  if (options.onLlmCall) gem.onCall = options.onLlmCall;

  const { segments: merged, allTurns, voiceDist } = await orchestrateChunks({
    asr,
    durationSeconds: duration,
    instructions,
    subSegment,
    maxSinglePassSeconds: (options.maxSinglePassMinutes ?? 35) * 60,
    chunkSeconds: (options.chunkMinutes ?? 15) * 60,
    overlapSeconds: (options.chunkOverlapMinutes ?? 2) * 60,
    signal: options.signal,
    onProgress: (msg) => progress("diarize", msg),
    // browser-specific: slice the chunk's audio with ffmpeg.wasm, call Gemini over fetch.
    diarizeChunk: async ({ chunk, chunked, prompt }) => {
      const audioBytes = chunked
        ? await extractAudioWasm(ffmpeg, null, { inputName: fullAudioName, startSeconds: chunk.startSeconds, durationSeconds: chunk.endSeconds - chunk.startSeconds, keepInput: true })
        : fullAudio;
      const res = await gem.generate(
        [
          { data: { bytes: audioBytes, mimeType: "audio/mp3", displayName: `chunk_${chunk.index}` } },
          ...keyframes.map((kf) => ({ data: { bytes: kf, mimeType: "image/jpeg" } })),
          { text: prompt },
        ],
        { model: llmModel, temperature: 0.2, maxOutputTokens: 65536, thinkingLevel: llmThinkingLevel, systemInstruction: DIARIZATION_SYSTEM, label: chunked ? `diarize-chunk-${chunk.index}` : "diarize" }
      );
      if (!res.text.trim()) throw new Error(`Diarization returned empty text${chunked ? ` (chunk ${chunk.index})` : ""}`);
      return res.text;
    },
  });

  // 7. identify
  let resolvedNames: Record<string, string> | undefined;
  let descriptions: Record<string, string> | undefined;
  if (identifySpeakers) {
    progress("identify", "Resolving speaker identities");
    const identGen: TextGenerator = {
      generate: (parts, opts) => gem.generate(parts.map((p) => ({ text: p.text })), opts),
    };
    try {
      const ident = await identifySpeakersLLM(identGen, allTurns, {
        instructions,
        llmModel,
        asrSpeakerByLabel: Object.keys(voiceDist).length ? voiceDist : undefined,
      });
      resolvedNames = ident.resolvedNames;
      descriptions = ident.descriptions;
    } catch {
      /* keep raw labels */
    }
  }

  // 8. build + format
  progress("format", "Formatting outputs");
  const transcript = buildTranscript(
    merged,
    {
      source: "browser-input",
      durationSeconds: duration,
      processedAt: new Date().toISOString(),
      asrProvider: asr.provider,
      llmModel,
      userInstructions: instructions,
      language: asr.language,
    },
    { knownSpeakers, resolvedNames, descriptions }
  );

  progress("done", `${transcript.segments.length} segments, ${transcript.speakers.length} speakers (${secondsToCompact(duration)})`);
  return { transcript, srt: toSRT(transcript), markdown: toMarkdown(transcript), json: toJSON(transcript), asr };
}
