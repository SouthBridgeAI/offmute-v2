/**
 * ElevenLabs Scribe provider — timestamped transcription with diarization.
 * Scribe v2 has the strongest published speaker-label accuracy of the hosted ASRs,
 * making it a first-class alternative clock to AssemblyAI.
 *
 * The API returns one flat word stream (words + spacing + audio events) with a
 * speaker_id per word; we rebuild utterances by grouping consecutive same-speaker
 * words, matching the shape the consistency pass expects.
 */
import type { TimestampedUtterance, TimestampedWord } from "../core/types.js";
import type { TimestampedResult } from "./whisper-groq.js";
import { withRetry } from "../utils/retry.js";

interface ScribeWord {
  text: string;
  start?: number;
  end?: number;
  type: "word" | "spacing" | "audio_event";
  speaker_id?: string;
}

interface ScribeResponse {
  text: string;
  language_code?: string;
  audio_duration_secs?: number;
  transcription_id?: string;
  words?: ScribeWord[];
}

export interface ElevenLabsOptions {
  model?: string; // scribe_v2 (default) | scribe_v1
  /** Key terms to bias recognition toward (names, jargon) — fed from --instructions. */
  keyterms?: string[];
  numSpeakers?: number;
}

const MAX_UTTERANCE_GAP_SEC = 1.5;

export class ElevenLabsClient {
  constructor(
    private apiKey: string,
    private baseUrl = "https://api.elevenlabs.io/v1",
  ) {}

  async transcribe(
    audio: ArrayBuffer | Uint8Array | Blob,
    opts: ElevenLabsOptions = {},
  ): Promise<TimestampedResult> {
    const model = opts.model ?? "scribe_v2";
    const blob = audio instanceof Blob ? audio : new Blob([audio], { type: "audio/mpeg" });
    const form = new FormData();
    form.append("file", blob, "audio.mp3");
    form.append("model_id", model);
    form.append("timestamps_granularity", "word");
    form.append("diarize", "true");
    form.append("tag_audio_events", "false");
    if (opts.numSpeakers) form.append("num_speakers", String(opts.numSpeakers));
    for (const term of opts.keyterms ?? []) form.append("keyterms", term);

    const data = await withRetry("elevenlabs", async () => {
      const res = await fetch(`${this.baseUrl}/speech-to-text`, {
        method: "POST",
        headers: { "xi-api-key": this.apiKey },
        body: form,
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`ElevenLabs Scribe ${res.status}: ${txt.slice(0, 300)}`);
      }
      return (await res.json()) as ScribeResponse;
    });

    const words: (TimestampedWord & { speaker: string })[] = [];
    for (const w of data.words ?? []) {
      if (w.type !== "word") continue;
      if (w.start === undefined || w.end === undefined) continue;
      words.push({
        text: w.text.trim(),
        start: w.start,
        end: w.end,
        speaker: w.speaker_id ?? "speaker_0",
      });
    }

    // Rebuild utterances: split on speaker change or a long silence.
    const utterances: TimestampedUtterance[] = [];
    let cur: (TimestampedWord & { speaker: string })[] = [];
    const flush = () => {
      if (cur.length === 0) return;
      utterances.push({
        speaker: cur[0]!.speaker,
        start: cur[0]!.start,
        end: cur[cur.length - 1]!.end,
        text: cur.map((w) => w.text).join(" "),
        words: cur.map(({ text, start, end }) => ({ text, start, end })),
      });
      cur = [];
    };
    for (const w of words) {
      const prev = cur[cur.length - 1];
      if (prev && (w.speaker !== prev.speaker || w.start - prev.end > MAX_UTTERANCE_GAP_SEC)) {
        flush();
      }
      cur.push(w);
    }
    flush();

    const speakers = [...new Set(words.map((w) => w.speaker))];
    return {
      utterances,
      words: words.map(({ text, start, end }) => ({ text, start, end })),
      durationSec:
        data.audio_duration_secs ?? (words.length ? words[words.length - 1]!.end : 0),
      speakers,
      hasDiarization: true,
      transcriptId: data.transcription_id ?? `elevenlabs-${model}`,
    };
  }
}
