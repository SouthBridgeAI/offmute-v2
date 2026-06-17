/**
 * Gemini provider (new @google/genai SDK) — the multimodal "understanding" layer:
 * diarization, speaker identification, tone, text correction. Node-only (file upload).
 */
import { GoogleGenAI } from "@google/genai";
import { basename, extname } from "node:path";
import { withRetry } from "../core/retry.js";

const MIME_BY_EXT: Record<string, string> = {
  ".mp3": "audio/mp3",
  ".mpga": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".opus": "audio/opus",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export function mimeForPath(path: string): string {
  const ext = extname(path).toLowerCase();
  const m = MIME_BY_EXT[ext];
  if (!m) throw new Error(`Unknown mime for ${path}`);
  return m;
}

/** Retry wrapper that logs attempts to stderr (Node). */
function retry<T>(fn: () => Promise<T>, label: string, retries?: number): Promise<T> {
  return withRetry(fn, {
    retries,
    onRetry: ({ attempt, retries: n, delayMs, error }) =>
      process.stderr.write(
        `\n  [retry ${label} ${attempt}/${n} in ${delayMs}ms] ${(error as Error)?.message?.slice(0, 90) ?? String(error)}`
      ),
  });
}

export interface UploadedFile {
  uri: string;
  mimeType: string;
  name: string;
}

export interface GeminiPart {
  /** a local file path to upload, OR */
  filePath?: string;
  /** an already-uploaded file, OR */
  uploaded?: UploadedFile;
  /** plain text */
  text?: string;
}

export interface GeminiOptions {
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** JSON schema for structured output; if set, responseMimeType=application/json */
  schema?: unknown;
  /** system instruction */
  systemInstruction?: string;
  /** thinking budget in tokens (Gemini 2.5 family). Ignored by Gemini 3.x. */
  thinkingBudget?: number;
  /** thinking level (Gemini 3.x family): "MINIMAL" | "LOW" | "MEDIUM" | "HIGH". */
  thinkingLevel?: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
  /** retries on transient API errors (default 4) */
  retries?: number;
}

export interface GeminiResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number; thoughtsTokens?: number };
  model: string;
  raw: unknown;
}

export class GeminiClient {
  private ai: GoogleGenAI;
  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!key) throw new Error("Missing GEMINI_API_KEY / GOOGLE_API_KEY");
    this.ai = new GoogleGenAI({ apiKey: key });
  }

  /** Upload a local file via the Files API and wait until it's ACTIVE. */
  async uploadFile(filePath: string, mimeType?: string): Promise<UploadedFile> {
    const mt = mimeType ?? mimeForPath(filePath);
    const uploaded = await retry(
      () => this.ai.files.upload({ file: filePath, config: { mimeType: mt, displayName: basename(filePath) } }),
      `upload ${basename(filePath)}`
    );
    let file = uploaded;
    // poll until processed
    const name = file.name as string;
    while (file.state === "PROCESSING") {
      await new Promise((r) => setTimeout(r, 1500));
      file = await this.ai.files.get({ name });
    }
    if (file.state === "FAILED") throw new Error(`Gemini file processing failed: ${name}`);
    return { uri: file.uri as string, mimeType: (file.mimeType as string) ?? mt, name };
  }

  async deleteFile(name: string): Promise<void> {
    try {
      await this.ai.files.delete({ name });
    } catch {
      /* ignore */
    }
  }

  /** Generate content from a mix of files (paths or pre-uploaded) and text. */
  async generate(parts: GeminiPart[], options: GeminiOptions = {}): Promise<GeminiResult> {
    const model = options.model ?? "gemini-flash-latest";
    const builtParts: Array<Record<string, unknown>> = [];
    const toCleanup: string[] = [];

    for (const p of parts) {
      if (p.text !== undefined) {
        builtParts.push({ text: p.text });
      } else if (p.uploaded) {
        builtParts.push({ fileData: { fileUri: p.uploaded.uri, mimeType: p.uploaded.mimeType } });
      } else if (p.filePath) {
        const up = await this.uploadFile(p.filePath);
        toCleanup.push(up.name);
        builtParts.push({ fileData: { fileUri: up.uri, mimeType: up.mimeType } });
      }
    }

    const config: Record<string, unknown> = {
      temperature: options.temperature ?? 0.2,
    };
    if (options.maxOutputTokens) config["maxOutputTokens"] = options.maxOutputTokens;
    if (options.systemInstruction) config["systemInstruction"] = options.systemInstruction;
    if (options.schema) {
      config["responseMimeType"] = "application/json";
      config["responseSchema"] = options.schema;
    }
    // Gemini 3.x honors thinkingLevel; 2.5 honors thinkingBudget. Prefer level if given.
    if (options.thinkingLevel) {
      config["thinkingConfig"] = { thinkingLevel: options.thinkingLevel };
    } else if (options.thinkingBudget !== undefined) {
      config["thinkingConfig"] = { thinkingBudget: options.thinkingBudget };
    }

    try {
      const resp = await retry(
        () =>
          this.ai.models.generateContent({
            model,
            contents: [{ role: "user", parts: builtParts as never }],
            config,
          }),
        `generate ${model}`,
        options.retries ?? 4
      );
      const usage = (resp as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } }).usageMetadata;
      return {
        text: resp.text ?? "",
        usage: {
          inputTokens: usage?.promptTokenCount,
          outputTokens: usage?.candidatesTokenCount,
          thoughtsTokens: usage?.thoughtsTokenCount,
        },
        model,
        raw: resp,
      };
    } finally {
      // best-effort cleanup of files we uploaded here
      await Promise.all(toCleanup.map((n) => this.deleteFile(n)));
    }
  }
}
