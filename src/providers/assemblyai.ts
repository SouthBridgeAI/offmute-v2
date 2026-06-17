/**
 * AssemblyAI ASR provider — the precise-timing + baseline-diarization backbone.
 * Returns word-level + utterance-level timestamps (converted to seconds) and
 * speaker labels (A, B, ...). Node-only (uploads a local file).
 */
import { AssemblyAI } from "assemblyai";
import type { AsrResult, AsrUtterance, TimedWord } from "../types.js";

export interface AssemblyAiOptions {
  apiKey?: string;
  /** enable speaker diarization (default true) */
  speakerLabels?: boolean;
  /** hint for number of speakers (optional) */
  speakersExpected?: number;
  /** model tier / speech model, e.g. "best" | "nano" | "universal" (provider default if unset) */
  speechModel?: string;
  /** language code hint, e.g. "en" */
  languageCode?: string;
}

/** ms -> seconds */
const s = (ms: number | null | undefined): number => (ms ?? 0) / 1000;

export async function transcribeWithAssemblyAI(
  audioPath: string,
  options: AssemblyAiOptions = {}
): Promise<{ asr: AsrResult; raw: unknown }> {
  const apiKey = options.apiKey ?? process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) throw new Error("Missing ASSEMBLYAI_API_KEY");

  const client = new AssemblyAI({ apiKey });

  const params: Record<string, unknown> = {
    audio: audioPath,
    speaker_labels: options.speakerLabels !== false,
  };
  if (options.speakersExpected) params["speakers_expected"] = options.speakersExpected;
  if (options.speechModel) params["speech_model"] = options.speechModel;
  if (options.languageCode) params["language_code"] = options.languageCode;

  // transcribe() handles upload + polling to completion.
  const t = (await client.transcripts.transcribe(params as never)) as {
    status: string;
    error?: string;
    audio_duration?: number;
    language_code?: string;
    words?: Array<{ text: string; start: number; end: number; confidence?: number; speaker?: string | null }>;
    utterances?: Array<{
      text: string;
      start: number;
      end: number;
      confidence?: number;
      speaker?: string | null;
      words?: Array<{ text: string; start: number; end: number; confidence?: number; speaker?: string | null }>;
    }> | null;
  };

  if (t.status === "error") throw new Error(`AssemblyAI failed: ${t.error}`);

  const words: TimedWord[] = (t.words ?? []).map((w) => ({
    text: w.text,
    start: s(w.start),
    end: s(w.end),
    confidence: w.confidence,
    speaker: w.speaker ?? undefined,
  }));

  const utterances: AsrUtterance[] = (t.utterances ?? []).map((u) => ({
    text: u.text,
    start: s(u.start),
    end: s(u.end),
    speaker: u.speaker ?? "?",
    confidence: u.confidence,
    words: u.words?.map((w) => ({
      text: w.text,
      start: s(w.start),
      end: s(w.end),
      confidence: w.confidence,
      speaker: w.speaker ?? undefined,
    })),
  }));

  const speakerSet = new Set<string>();
  for (const u of utterances) speakerSet.add(u.speaker);
  for (const w of words) if (w.speaker) speakerSet.add(w.speaker);

  const asr: AsrResult = {
    provider: "assemblyai",
    model: options.speechModel,
    words,
    utterances,
    speakers: [...speakerSet].sort(),
    durationSeconds: t.audio_duration ?? (words.length ? words[words.length - 1]!.end : 0),
    language: t.language_code,
    diarized: utterances.length > 0 && speakerSet.size > 0,
  };
  return { asr, raw: t };
}
