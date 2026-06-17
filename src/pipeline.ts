/**
 * offmute-v2 pipeline orchestrator (Node).
 * probe → preprocess → ASR(timing) → diarize(LLM) → align → identify → format.
 */
import { basename, dirname, extname, join } from "node:path";
import { existsSync } from "node:fs";
import type {
  AsrResult,
  LlmLine,
  Speaker,
  Transcript,
  TranscriptSegment,
} from "./types.js";
import { probeMedia, extractAudio, extractKeyframes } from "./media/ffmpeg.js";
import { transcribeWithAssemblyAI } from "./providers/assemblyai.js";
import { GeminiClient } from "./providers/gemini.js";
import { buildAsrHint, buildDiarizationPrompt, DIARIZATION_SYSTEM } from "./core/prompts.js";
import { parseDiarizedText } from "./core/parse-diarized.js";
import { alignLlmToAsr, fillTokenTimes, buildSegmentsFromTokens, asrSpeakerByLabel } from "./core/align.js";
import { buildSpeakers } from "./core/speakers.js";
import { relTimeToSeconds } from "./core/time.js";
import { toJSON, toMarkdown, toSRT } from "./core/format.js";
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
  llmThinkingBudget?: number;
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
  apiKeys?: { gemini?: string; assemblyai?: string };
  /** force chunking threshold in minutes (default 35; longer files are chunked) */
  maxSinglePassMinutes?: number;
}

export interface TranscribeResult {
  transcript: Transcript;
  srt: string;
  markdown: string;
  json: string;
  intermediatesDir: string;
  asr?: AsrResult;
}

const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);

export async function transcribe(
  input: string,
  options: TranscribeOptions = {}
): Promise<TranscribeResult> {
  const {
    instructions,
    asr: asrProvider = "assemblyai",
    llmModel = "gemini-flash-latest",
    llmThinkingBudget = 4096,
    keyframeCount = 8,
    subSegment = true,
    identifySpeakers = true,
    knownSpeakers,
    cache = true,
    onProgress,
    apiKeys,
  } = options;

  const progress = (stage: string, message: string, pct?: number) =>
    onProgress?.({ stage, message, pct });

  if (!existsSync(input)) throw new Error(`Input not found: ${input}`);

  const base = basename(input, extname(input));
  const interDir = options.intermediatesDir ?? join(dirname(input), `.offmute_${base}`);
  const inter = new Intermediates(interDir);

  // 1. Probe -------------------------------------------------------------
  progress("probe", `Probing ${basename(input)}`);
  const info = await inter.cachedJSON("media-info.json", cache, () => probeMedia(input));
  const isVideo = info.hasVideo && VIDEO_EXT.has(extname(input).toLowerCase());
  const useVideo = options.useVideo ?? isVideo;

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
  }

  // 3. ASR pass (timing) -------------------------------------------------
  let asr: AsrResult | undefined;
  if (asrProvider === "assemblyai") {
    progress("asr", "Transcribing for word-level timing (AssemblyAI)");
    asr = await inter.cachedJSON<AsrResult>("asr.json", cache, async () => {
      const { asr: r } = await transcribeWithAssemblyAI(audioPath, {
        apiKey: apiKeys?.assemblyai,
        speakerLabels: true,
        speechModel: options.asrModel,
      });
      return r;
    });
  }

  // 4. Diarize pass (content) -------------------------------------------
  const gemini = new GeminiClient(apiKeys?.gemini);
  const asrHint = asr && asr.diarized ? buildAsrHint(asr) : undefined;
  const prompt = buildDiarizationPrompt({ instructions, asrHint });

  progress("diarize", `Diarizing with ${llmModel}`);
  const diarizeText = await inter.cachedText("diarize.txt", cache, async () => {
    const parts = [
      { filePath: audioPath },
      ...keyframePaths.map((p) => ({ filePath: p })),
      { text: prompt },
    ];
    const res = await gemini.generate(parts, {
      model: llmModel,
      temperature: 0.2,
      maxOutputTokens: 65536,
      thinkingBudget: llmThinkingBudget,
      systemInstruction: DIARIZATION_SYSTEM,
    });
    inter.writeJSON("diarize.meta.json", { model: res.model, usage: res.usage });
    if (!res.text.trim()) throw new Error("Diarization returned empty text");
    return res.text;
  });

  const turns = parseDiarizedText(diarizeText);
  if (turns.length === 0) throw new Error("No diarized turns parsed from LLM output");

  // 5. Align + segment ---------------------------------------------------
  progress("align", "Aligning transcript to word timings");
  let segments: Array<{ start: number; end: number; speakerLabel: string; tone?: string; text: string; matchRatio: number }>;
  let voiceDist: Record<string, Record<string, number>> | undefined;
  if (asr) {
    const tokens = alignLlmToAsr(turns, asr.words);
    fillTokenTimes(tokens, asr.durationSeconds);
    voiceDist = asrSpeakerByLabel(tokens, turns.map((t) => t.speaker));
    const aligned = buildSegmentsFromTokens(turns, tokens, { subSegment });
    // tone belongs to a whole turn — only attach it to the first sub-segment of each turn
    const toneSeen = new Set<number>();
    segments = aligned
      .filter((s) => s.matchedTokens > 0)
      .map((s) => {
        const turn = turns[s.turnIndex]!;
        const firstOfTurn = !toneSeen.has(s.turnIndex);
        toneSeen.add(s.turnIndex);
        return {
          start: s.start,
          end: s.end,
          speakerLabel: turn.speaker,
          tone: firstOfTurn ? turn.tone : undefined,
          text: s.text,
          matchRatio: s.matchRatio,
        };
      });
  } else {
    // no-ASR fallback: use the LLM's coarse approxStart timestamps
    segments = turnsToApproxSegments(turns, info.durationSeconds);
  }

  // 6. Identify / canonicalize speakers ---------------------------------
  let aliases: Record<string, string> | undefined;
  let descriptions: Record<string, string> | undefined;
  if (identifySpeakers && turns.length > 0) {
    progress("identify", "Resolving speaker identities");
    try {
      const ident = await inter.cachedJSON("identify.json", cache, () =>
        identifySpeakersLLM(gemini, turns, { instructions, llmModel, asrSpeakerByLabel: voiceDist })
      );
      aliases = ident.aliases;
      descriptions = ident.descriptions;
    } catch (e) {
      progress("identify", `Identify pass failed, using raw labels: ${(e as Error).message}`);
    }
  }

  const rawLabels = segments.map((s) => s.speakerLabel);
  const { speakers, labelToId } = buildSpeakers(rawLabels, { knownSpeakers, aliases, descriptions });

  // 7. Build Transcript --------------------------------------------------
  const transcriptSegments: TranscriptSegment[] = segments.map((s, i) => ({
    id: i + 1,
    start: s.start,
    end: s.end,
    speakerId: labelToId.get(s.speakerLabel) ?? s.speakerLabel,
    text: s.text,
    tone: s.tone,
    timingSource: asr ? "asr" : "llm",
    alignmentConfidence: s.matchRatio,
  }));

  const transcript: Transcript = {
    segments: transcriptSegments,
    speakers: dedupeSpeakers(speakers),
    metadata: {
      source: basename(input),
      durationSeconds: info.durationSeconds,
      processedAt: new Date().toISOString(),
      asrProvider: asr?.provider,
      llmModel,
      userInstructions: instructions,
      language: asr?.language,
    },
  };

  // 8. Format + persist --------------------------------------------------
  progress("format", "Writing outputs");
  const srt = toSRT(transcript, { includeSpeaker: true });
  const markdown = toMarkdown(transcript, { title: base });
  const json = toJSON(transcript);
  inter.writeText("transcript.srt", srt);
  inter.writeText("transcript.md", markdown);
  inter.writeText("transcript.json", json);

  progress("done", `Done — ${transcript.segments.length} segments, ${transcript.speakers.length} speakers`, 100);
  return { transcript, srt, markdown, json, intermediatesDir: interDir, asr };
}

function turnsToApproxSegments(
  turns: LlmLine[],
  totalDuration: number
): Array<{ start: number; end: number; speakerLabel: string; tone?: string; text: string; matchRatio: number }> {
  return turns.map((t, i) => {
    const start = t.approxStart ?? relTimeToSeconds(`0:00`) ?? 0;
    const next = turns[i + 1];
    const end = next?.approxStart ?? totalDuration;
    return { start, end: Math.max(start, end), speakerLabel: t.speaker, tone: t.tone, text: t.text, matchRatio: 0 };
  });
}

function dedupeSpeakers(speakers: Speaker[]): Speaker[] {
  const byId = new Map<string, Speaker>();
  for (const s of speakers) if (!byId.has(s.id)) byId.set(s.id, s);
  return [...byId.values()];
}
