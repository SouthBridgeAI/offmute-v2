/**
 * Isomorphic Gemini provider over `fetch` (works in the browser AND Node 18+).
 * No SDK dependency, so it can live in the browser bundle. Uploads via the Files
 * API resumable protocol and calls generateContent over REST.
 */
import { withRetry } from "../core/retry.js";

const DEFAULT_BASE = "https://generativelanguage.googleapis.com";

export type Bytes = Uint8Array | ArrayBuffer | Blob;

export interface GeminiFetchPart {
  /** plain text */
  text?: string;
  /** raw media to upload via the Files API */
  data?: { bytes: Bytes; mimeType: string; displayName?: string };
  /** an already-uploaded file */
  uploaded?: { uri: string; mimeType: string };
}

export interface UploadedFile {
  uri: string;
  mimeType: string;
  name: string;
  state: string;
}

export interface GeminiFetchOptions {
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  systemInstruction?: string;
  thinkingLevel?: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
  thinkingBudget?: number;
  retries?: number;
  /** JSON schema for structured output */
  schema?: unknown;
}

export interface GeminiFetchResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number; thoughtsTokens?: number };
  model: string;
  raw: unknown;
}

async function toUint8(b: Bytes): Promise<Uint8Array> {
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  // Blob
  return new Uint8Array(await b.arrayBuffer());
}

/** fetch that throws an error carrying `.status` on non-2xx (so retry sees it). */
async function fetchOk(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`HTTP ${res.status} ${url.split("?")[0]}: ${body.slice(0, 300)}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res;
}

export class GeminiFetchClient {
  private key: string;
  private base: string;
  constructor(apiKey?: string, baseUrl: string = DEFAULT_BASE) {
    const env = typeof process !== "undefined" ? process.env : undefined;
    const key = apiKey ?? env?.["GEMINI_API_KEY"] ?? env?.["GOOGLE_API_KEY"];
    if (!key) throw new Error("Missing GEMINI_API_KEY / GOOGLE_API_KEY");
    this.key = key;
    this.base = baseUrl;
  }

  /** Upload media via the Files API resumable protocol; poll until ACTIVE. */
  async uploadFile(bytes: Bytes, mimeType: string, displayName = "media"): Promise<UploadedFile> {
    const buf = await toUint8(bytes);
    const numBytes = buf.byteLength;

    const start = await withRetry(
      () =>
        fetchOk(`${this.base}/upload/v1beta/files?key=${this.key}`, {
          method: "POST",
          headers: {
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": String(numBytes),
            "X-Goog-Upload-Header-Content-Type": mimeType,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ file: { display_name: displayName } }),
        }),
      { retries: 3 }
    );
    const uploadUrl = start.headers.get("x-goog-upload-url");
    if (!uploadUrl) throw new Error("Gemini Files API: missing upload URL");

    const finalize = await withRetry(
      () =>
        fetchOk(uploadUrl, {
          method: "POST",
          headers: {
            "X-Goog-Upload-Command": "upload, finalize",
            "X-Goog-Upload-Offset": "0",
            "Content-Length": String(numBytes),
          },
          // Uint8Array is a valid BodyInit in node 18+ and browsers
          body: buf as unknown as BodyInit,
        }),
      { retries: 3 }
    );
    let file = ((await finalize.json()) as { file: { name: string; uri: string; mimeType: string; state: string } }).file;

    while (file.state === "PROCESSING") {
      await new Promise((r) => setTimeout(r, 1500));
      file = (await fetchOk(`${this.base}/v1beta/${file.name}?key=${this.key}`, { method: "GET" }).then((r) => r.json())) as typeof file;
    }
    if (file.state === "FAILED") throw new Error(`Gemini file processing failed: ${file.name}`);
    return { uri: file.uri, mimeType: file.mimeType, name: file.name, state: file.state };
  }

  async deleteFile(name: string): Promise<void> {
    try {
      await fetch(`${this.base}/v1beta/${name}?key=${this.key}`, { method: "DELETE" });
    } catch {
      /* ignore */
    }
  }

  async generate(parts: GeminiFetchPart[], options: GeminiFetchOptions = {}): Promise<GeminiFetchResult> {
    const model = options.model ?? "gemini-flash-latest";
    const built: Array<Record<string, unknown>> = [];
    const cleanup: string[] = [];
    for (const p of parts) {
      if (p.text !== undefined) built.push({ text: p.text });
      else if (p.uploaded) built.push({ fileData: { fileUri: p.uploaded.uri, mimeType: p.uploaded.mimeType } });
      else if (p.data) {
        const up = await this.uploadFile(p.data.bytes, p.data.mimeType, p.data.displayName);
        cleanup.push(up.name);
        built.push({ fileData: { fileUri: up.uri, mimeType: up.mimeType } });
      }
    }

    const generationConfig: Record<string, unknown> = { temperature: options.temperature ?? 0.2 };
    if (options.maxOutputTokens) generationConfig["maxOutputTokens"] = options.maxOutputTokens;
    if (options.thinkingLevel) generationConfig["thinkingConfig"] = { thinkingLevel: options.thinkingLevel };
    else if (options.thinkingBudget !== undefined) generationConfig["thinkingConfig"] = { thinkingBudget: options.thinkingBudget };
    if (options.schema) {
      generationConfig["responseMimeType"] = "application/json";
      generationConfig["responseSchema"] = options.schema;
    }

    const body: Record<string, unknown> = {
      contents: [{ role: "user", parts: built }],
      generationConfig,
    };
    if (options.systemInstruction) body["systemInstruction"] = { parts: [{ text: options.systemInstruction }] };

    try {
      const resp = (await withRetry(
        () =>
          fetchOk(`${this.base}/v1beta/models/${model}:generateContent?key=${this.key}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }).then((r) => r.json()),
        { retries: options.retries ?? 4 }
      )) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
      };
      const text = (resp.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
      const u = resp.usageMetadata;
      return {
        text,
        usage: { inputTokens: u?.promptTokenCount, outputTokens: u?.candidatesTokenCount, thoughtsTokens: u?.thoughtsTokenCount },
        model,
        raw: resp,
      };
    } finally {
      await Promise.all(cleanup.map((n) => this.deleteFile(n)));
    }
  }
}
