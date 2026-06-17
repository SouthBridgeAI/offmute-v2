/**
 * Browser orchestrator: ffmpeg.wasm (host-loaded) + fetch providers + the pure
 * fusion core. Mirrors the Node pipeline (preprocess → ASR → diarize → align →
 * merge → identify → format), including chunking for long media. Runs entirely in
 * the browser; keys are injected by the host.
 */
import type { AsrResult, LlmLine, Transcript } from "./types.js";
import type { FFmpegLike } from "./media/ffmpeg-wasm.js";
import { extractAudioWasm, extractKeyframesWasm, writeInput } from "./media/ffmpeg-wasm.js";
import { transcribeWithAssemblyAIFetch } from "./providers/assemblyai-fetch.js";
import { GeminiFetchClient } from "./providers/gemini-fetch.js";
import { buildAsrHint, buildDiarizationPrompt, DIARIZATION_SYSTEM } from "./core/prompts.js";
import { parseDiarizedText } from "./core/parse-diarized.js";
import { alignTurnsToSegments, buildTranscript, type PlainSegment } from "./core/assemble.js";
import { calculateChunks, mergeChunkSegments, type MergeableSegment } from "./core/chunk.js";
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
}

export interface BrowserTranscribeResult {
  transcript: Transcript;
  srt: string;
  markdown: string;
  json: string;
  asr: AsrResult;
}

function sliceAsrWindow(asr: AsrResult, start: number, end: number, relative: boolean): AsrResult {
  const off = relative ? start : 0;
  const utterances = asr.utterances
    .filter((u) => u.end >= start && u.start <= end)
    .map((u) => ({ ...u, start: u.start - off, end: u.end - off }));
  return { ...asr, utterances, words: [] };
}

function mergeVoiceDist(target: Record<string, Record<string, number>>, source: Record<string, Record<string, number>>): void {
  for (const [label, counts] of Object.entries(source)) {
    target[label] ??= {};
    for (const [sp, n] of Object.entries(counts)) target[label]![sp] = (target[label]![sp] ?? 0) + n;
  }
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

  // 4-5. diarize (single-pass or chunked) + align
  const gem = new GeminiFetchClient(apiKeys.gemini);
  const maxSingleSec = (options.maxSinglePassMinutes ?? 35) * 60;
  const chunkSec = (options.chunkMinutes ?? 15) * 60;
  const overlapSec = (options.chunkOverlapMinutes ?? 2) * 60;
  const timeChunks = duration <= maxSingleSec ? [{ index: 0, startSeconds: 0, endSeconds: duration }] : calculateChunks(duration, chunkSec, overlapSec);
  const chunked = timeChunks.length > 1;

  const allTurns: LlmLine[] = [];
  const mergeable: MergeableSegment[] = [];
  const voiceDist: Record<string, Record<string, number>> = {};
  let previousTail = "";

  for (const ch of timeChunks) {
    progress("diarize", chunked ? `Diarizing chunk ${ch.index + 1}/${timeChunks.length}` : `Diarizing with ${llmModel}`);
    const audioBytes = chunked
      ? await extractAudioWasm(ffmpeg, null, { inputName: fullAudioName, startSeconds: ch.startSeconds, durationSeconds: ch.endSeconds - ch.startSeconds, keepInput: true })
      : fullAudio;

    const windowHint = asr.diarized ? buildAsrHint(sliceAsrWindow(asr, ch.startSeconds, ch.endSeconds, chunked)) : undefined;
    const prompt = buildDiarizationPrompt({
      instructions,
      asrHint: windowHint,
      chunk: chunked ? { index: ch.index, total: timeChunks.length, startSeconds: ch.startSeconds } : undefined,
      previousTail: chunked ? previousTail : undefined,
    });

    const res = await gem.generate(
      [
        { data: { bytes: audioBytes, mimeType: "audio/mp3", displayName: `chunk_${ch.index}` } },
        ...keyframes.map((kf) => ({ data: { bytes: kf, mimeType: "image/jpeg" } })),
        { text: prompt },
      ],
      { model: llmModel, temperature: 0.2, maxOutputTokens: 65536, thinkingLevel: llmThinkingLevel, systemInstruction: DIARIZATION_SYSTEM }
    );
    if (!res.text.trim()) throw new Error(`Diarization returned empty text${chunked ? ` (chunk ${ch.index})` : ""}`);

    const turns = parseDiarizedText(res.text);
    previousTail = turns.slice(-3).map((t) => `${t.speaker}: ${t.text}`).join("\n");
    if (chunked) for (const t of turns) if (t.approxStart !== undefined) t.approxStart += ch.startSeconds;
    allTurns.push(...turns);

    const windowWords = chunked ? asr.words.filter((w) => w.start >= ch.startSeconds - 2 && w.start <= ch.endSeconds + 2) : asr.words;
    const { segments, voiceDist: vd } = alignTurnsToSegments(turns, windowWords, duration, subSegment);
    mergeVoiceDist(voiceDist, vd);
    for (const s of segments) mergeable.push({ ...s, chunkIndex: ch.index });
  }

  if (allTurns.length === 0) throw new Error("No diarized turns parsed from LLM output");

  // 6. merge overlaps
  const merged: PlainSegment[] = (chunked ? mergeChunkSegments(mergeable, timeChunks) : mergeable).map((m) => ({
    start: m.start,
    end: m.end,
    speakerLabel: m.speakerLabel,
    tone: m.tone,
    text: m.text,
    matchRatio: m.matchRatio,
  }));

  // 7. identify
  let aliases: Record<string, string> | undefined;
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
      aliases = ident.aliases;
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
    { knownSpeakers, aliases, descriptions }
  );

  progress("done", `${transcript.segments.length} segments, ${transcript.speakers.length} speakers (${secondsToCompact(duration)})`);
  return { transcript, srt: toSRT(transcript), markdown: toMarkdown(transcript), json: toJSON(transcript), asr };
}
