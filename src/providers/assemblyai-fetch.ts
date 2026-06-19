/**
 * Fetch-based AssemblyAI client (no SDK, no node deps — browser + node). Uploads a
 * Blob, creates a transcript with speaker_labels + universal model, polls, and
 * returns utterances + words. Same shape as the node provider's result.
 */
import type { TimestampedUtterance, TimestampedWord } from "../core/types.js";

export interface AssemblyAIFetchResult {
  utterances: TimestampedUtterance[];
  words: TimestampedWord[];
  durationSec: number;
  speakers: string[];
  transcriptId: string;
}

const BASE = "https://api.assemblyai.com/v2";

export class AssemblyAIFetchClient {
  constructor(private apiKey: string) {}

  async transcribe(audio: Blob, opts: { speakersExpected?: number } = {}): Promise<AssemblyAIFetchResult> {
    // 1. Upload.
    const upRes = await fetch(`${BASE}/upload`, {
      method: "POST",
      headers: { authorization: this.apiKey },
      body: audio,
    });
    if (!upRes.ok) throw new Error(`AssemblyAI upload ${upRes.status}: ${await upRes.text()}`);
    const { upload_url } = (await upRes.json()) as { upload_url: string };

    // 2. Create transcript.
    const params: Record<string, unknown> = {
      audio_url: upload_url,
      speaker_labels: true,
      speech_model: "universal",
    };
    if (opts.speakersExpected) params.speakers_expected = opts.speakersExpected;
    const cr = await fetch(`${BASE}/transcript`, {
      method: "POST",
      headers: { authorization: this.apiKey, "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!cr.ok) throw new Error(`AssemblyAI create ${cr.status}: ${await cr.text()}`);
    interface AaiT {
      id: string;
      status: string;
      error?: string;
      duration?: number;
      utterances?: { speaker: string; text: string; start?: number; end?: number; confidence?: number; words?: { text: string; start?: number; end?: number; confidence?: number }[] }[];
      words?: { text: string; start?: number; end?: number; confidence?: number }[];
    }
    const transcript = (await cr.json()) as AaiT;

    // 3. Poll.
    let t: AaiT = transcript;
    while (t.status !== "completed" && t.status !== "error") {
      await new Promise((r) => setTimeout(r, 2000));
      const pr = await fetch(`${BASE}/transcript/${t.id}`, { headers: { authorization: this.apiKey } });
      t = (await pr.json()) as AaiT;
    }
    if (t.status === "error") throw new Error(`AssemblyAI error: ${t.error}`);

    // 4. Map.
    const toWord = (w: { text: string; start?: number; end?: number; confidence?: number }): TimestampedWord => ({
      text: w.text,
      start: (w.start || 0) / 1000,
      end: (w.end || 0) / 1000,
      confidence: w.confidence,
    });
    const utterances: TimestampedUtterance[] = [];
    const speakers = new Set<string>();
    for (const u of t.utterances || []) {
      const speaker = `speaker_${u.speaker}`;
      speakers.add(speaker);
      utterances.push({
        speaker,
        text: u.text,
        start: (u.start || 0) / 1000,
        end: (u.end || 0) / 1000,
        confidence: u.confidence,
        words: (u.words || []).map(toWord),
      });
    }
    const words: TimestampedWord[] = (t.words || []).map(toWord);
    const durationSec = words.length ? words[words.length - 1]!.end : 0;
    return { utterances, words, durationSec, speakers: [...speakers].sort(), transcriptId: t.id };
  }
}
