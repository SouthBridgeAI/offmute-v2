/**
 * Fetch-based Gemini client (no SDK, no node deps — works in browser AND node).
 * Sends audio as inline base64 (inlineData), which suits chunk-sized files
 * (≤ ~20MB). For larger files, chunk first (ffmpeg.wasm in browser, ffmpeg in node).
 */
import type { GeminiUsage } from "./gemini.js";

export interface GeminiFetchOptions {
  apiKey: string;
  /** Override base URL (e.g. a proxy). */
  baseUrl?: string;
}

export interface GeminiFetchGenerateOptions {
  temperature?: number;
  maxOutputTokens?: number;
  responseSchema?: Record<string, unknown>;
  systemInstruction?: string;
  maxRetries?: number;
}

export interface GeminiFetchResult {
  text: string;
  usage: GeminiUsage;
  error?: string;
}

const MIME_BY_EXT: Record<string, string> = {
  flac: "audio/flac",
  mp3: "audio/mp3",
  wav: "audio/wav",
  m4a: "audio/m4a",
  ogg: "audio/ogg",
  opus: "audio/opus",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** ArrayBuffer/Uint8Array → base64 (works in browser and node). */
export function toBase64(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  // btoa is available in browser and node 20+ (global).
  return (typeof btoa !== "undefined" ? btoa : (s: string) => Buffer.from(s, "binary").toString("base64"))(binary);
}

export class GeminiFetchClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(opts: GeminiFetchOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  }

  /** Generate from a prompt + inline file parts (ArrayBuffer + mimeType). */
  async generate(
    model: string,
    prompt: string,
    files: { data: ArrayBuffer | Uint8Array; mimeType?: string; ext?: string }[],
    opts: GeminiFetchGenerateOptions = {},
  ): Promise<GeminiFetchResult> {
    const maxRetries = opts.maxRetries ?? 3;
    const parts: unknown[] = [];
    for (const f of files) {
      const mimeType = f.mimeType ?? (f.ext ? MIME_BY_EXT[f.ext] : "audio/flac");
      parts.push({ inlineData: { mimeType, data: toBase64(f.data) } });
    }
    parts.push({ text: prompt });

    const body: Record<string, unknown> = {
      contents: [{ role: "user", parts }],
      generationConfig: {
        maxOutputTokens: opts.maxOutputTokens ?? 65536,
        temperature: opts.temperature ?? 0.2,
      },
    };
    if (opts.responseSchema) {
      (body.generationConfig as Record<string, unknown>).responseMimeType = "application/json";
      (body.generationConfig as Record<string, unknown>).responseSchema = opts.responseSchema;
    }
    if (opts.systemInstruction) body.systemInstruction = opts.systemInstruction;

    let lastError: string | undefined;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const res = await fetch(
          `${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
        }
        const data = (await res.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
        };
        const text =
          data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ?? "";
        const u = data.usageMetadata || {};
        return {
          text,
          usage: {
            inputTokens: u.promptTokenCount ?? 0,
            outputTokens: u.candidatesTokenCount ?? 0,
            totalTokens: u.totalTokenCount ?? 0,
          },
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < maxRetries - 1) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    return { text: "", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, error: lastError };
  }

  async generateJson<T = unknown>(
    model: string,
    prompt: string,
    files: { data: ArrayBuffer | Uint8Array; mimeType?: string; ext?: string }[],
    responseSchema: Record<string, unknown>,
    opts: GeminiFetchGenerateOptions = {},
  ): Promise<{ data: T | null; raw: string; error?: string }> {
    const r = await this.generate(model, prompt, files, { ...opts, responseSchema });
    if (r.error || !r.text) return { data: null, raw: r.text, error: r.error };
    try {
      let t = r.text.trim();
      const f = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (f && f[1]) t = f[1];
      return { data: JSON.parse(t) as T, raw: r.text };
    } catch (err) {
      return { data: null, raw: r.text, error: `JSON parse: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
