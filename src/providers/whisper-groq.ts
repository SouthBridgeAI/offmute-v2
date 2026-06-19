/**
 * Groq Whisper provider — a free/fast timestamped fallback when AssemblyAI is
 * unavailable. Returns word-level timestamps (no diarization — speakers come from
 * the LLM only via the consistency pass's label-grouping fallback).
 *
 * Groq's audio limit is 25MB, so feed a compressed mono mp3 (the pipeline extracts
 * one). For files larger than the limit, chunk first.
 */
import type { TimestampedUtterance, TimestampedWord } from "../core/types.js";

export interface TimestampedResult {
  utterances: TimestampedUtterance[];
  words: TimestampedWord[];
  durationSec: number;
  speakers: string[];
  /** Whether the ASR provider did its own speaker diarization. */
  hasDiarization: boolean;
  transcriptId: string;
}

export class WhisperGroqClient {
  constructor(
    private apiKey: string,
    private model = "whisper-large-v3-turbo",
    private baseUrl = "https://api.groq.com/openai/v1",
  ) {}

  async transcribe(audio: Blob | ArrayBuffer | Uint8Array): Promise<TimestampedResult> {
    const blob = audio instanceof Blob ? audio : new Blob([audio], { type: "audio/mpeg" });
    const form = new FormData();
    form.append("file", blob, "audio.mp3");
    form.append("model", this.model);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    form.append("timestamp_granularities[]", "segment");

    const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Groq Whisper ${res.status}: ${txt.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      duration?: number;
      words?: { word?: string; start: number; end: number }[];
      segments?: { text?: string; start: number; end: number }[];
    };

    const words: TimestampedWord[] = (data.words || []).map((w) => ({
      text: String(w.word || ""),
      start: w.start,
      end: w.end,
      confidence: undefined,
    }));
    // Whisper segments → utterances with NO speaker (diarization comes from the LLM).
    const utterances: TimestampedUtterance[] = (data.segments || []).map((s) => ({
      speaker: "speaker_A",
      text: String(s.text || "").trim(),
      start: s.start,
      end: s.end,
      confidence: undefined,
      words: words.filter((w) => w.start >= s.start && w.start < s.end),
    }));

    return {
      utterances,
      words,
      durationSec: data.duration ?? (words.length ? words[words.length - 1]!.end : 0),
      speakers: ["speaker_A"],
      hasDiarization: false,
      transcriptId: `groq-${this.model}`,
    };
  }
}
