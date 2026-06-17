/**
 * Isomorphic AssemblyAI provider over `fetch` (browser + Node 18+). No SDK.
 * Uploads raw audio bytes, requests a diarized transcript, polls, and normalizes
 * to AsrResult (ms → seconds).
 */
import type { AsrResult, AsrUtterance, TimedWord } from "../types.js";
import { withRetry } from "../core/retry.js";
import type { Bytes } from "./gemini-fetch.js";

const BASE = "https://api.assemblyai.com/v2";

export interface AssemblyAiFetchOptions {
  apiKey?: string;
  speakerLabels?: boolean;
  speakersExpected?: number;
  languageCode?: string;
  speechModel?: string;
  /** poll interval ms (default 2000) */
  pollMs?: number;
}

const s = (ms: number | null | undefined): number => (ms ?? 0) / 1000;

async function toBlobBody(b: Bytes): Promise<BodyInit> {
  if (b instanceof Uint8Array || b instanceof ArrayBuffer) return b as unknown as BodyInit;
  return b; // Blob
}

interface AaiWord { text: string; start: number; end: number; confidence?: number; speaker?: string | null }
interface AaiTranscript {
  status: string;
  error?: string;
  audio_duration?: number;
  language_code?: string;
  words?: AaiWord[];
  utterances?: Array<AaiWord & { words?: AaiWord[] }> | null;
}

export async function transcribeWithAssemblyAIFetch(
  audio: Bytes,
  options: AssemblyAiFetchOptions = {}
): Promise<{ asr: AsrResult; raw: AaiTranscript }> {
  const env = typeof process !== "undefined" ? process.env : undefined;
  const key = options.apiKey ?? env?.["ASSEMBLYAI_API_KEY"];
  if (!key) throw new Error("Missing ASSEMBLYAI_API_KEY");
  const auth = { authorization: key };
  const pollMs = options.pollMs ?? 2000;

  // 1. upload
  const uploaded = (await withRetry(
    async () => {
      const res = await fetch(`${BASE}/upload`, { method: "POST", headers: auth, body: await toBlobBody(audio) });
      if (!res.ok) {
        const e = new Error(`AssemblyAI upload HTTP ${res.status}`) as Error & { status?: number };
        e.status = res.status;
        throw e;
      }
      return res.json() as Promise<{ upload_url: string }>;
    },
    { retries: 3 }
  )) as { upload_url: string };

  // 2. create transcript
  const params: Record<string, unknown> = { audio_url: uploaded.upload_url, speaker_labels: options.speakerLabels !== false };
  if (options.speakersExpected) params["speakers_expected"] = options.speakersExpected;
  if (options.languageCode) params["language_code"] = options.languageCode;
  if (options.speechModel) params["speech_model"] = options.speechModel;

  const created = (await withRetry(
    async () => {
      const res = await fetch(`${BASE}/transcript`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const e = new Error(`AssemblyAI create HTTP ${res.status}`) as Error & { status?: number };
        e.status = res.status;
        throw e;
      }
      return res.json() as Promise<{ id: string }>;
    },
    { retries: 3 }
  )) as { id: string };

  // 3. poll
  let t: AaiTranscript;
  for (;;) {
    t = (await withRetry(() => fetch(`${BASE}/transcript/${created.id}`, { headers: auth }).then((r) => r.json()), { retries: 3 })) as AaiTranscript;
    if (t.status === "completed") break;
    if (t.status === "error") throw new Error(`AssemblyAI failed: ${t.error}`);
    await new Promise((r) => setTimeout(r, pollMs));
  }

  // 4. normalize
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
    words: u.words?.map((w) => ({ text: w.text, start: s(w.start), end: s(w.end), confidence: w.confidence, speaker: w.speaker ?? undefined })),
  }));
  const speakers = [...new Set([...utterances.map((u) => u.speaker), ...words.map((w) => w.speaker).filter(Boolean) as string[]])].sort();

  const asr: AsrResult = {
    provider: "assemblyai",
    model: options.speechModel,
    words,
    utterances,
    speakers,
    durationSeconds: t.audio_duration ?? (words.length ? words[words.length - 1]!.end : 0),
    language: t.language_code,
    diarized: utterances.length > 0 && speakers.length > 0,
  };
  return { asr, raw: t };
}
