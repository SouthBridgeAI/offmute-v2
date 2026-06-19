/**
 * Gemini provider (multimodal). Handles file upload + processing poll, text and
 * structured-JSON generation, retries, token tracking, and uploaded-file cleanup.
 *
 * Uses `@google/genai` v1 SDK. Audio is uploaded via the Files API (supports large
 * files) and referenced by URI in the generate request.
 */
import { GoogleGenAI, type File, type Part } from "@google/genai";
import { basename } from "node:path";
import { logger } from "../utils/logger.js";
import { logLlmCall } from "./llm-log.js";

export interface GeminiFileInput {
  path: string;
  mimeType?: string;
}

export interface GeminiUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface GeminiGenerateOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  temperature?: number;
  maxOutputTokens?: number;
  /** Force JSON output with this schema. */
  responseSchema?: Record<string, unknown>;
  /** System instruction. */
  systemInstruction?: string;
  /** What this call is for (logged): describe | transcribe | identify | … */
  logKind?: string;
  /** Chunk index (logged, for transcription calls). */
  logChunk?: number;
}

export interface GeminiResult {
  text: string;
  usage: GeminiUsage;
  error?: string;
}

const MIME_BY_EXT: Record<string, string> = {
  ".flac": "audio/flac",
  ".mp3": "audio/mp3",
  ".wav": "audio/wav",
  ".m4a": "audio/m4a",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function detectMime(path: string): string {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GeminiClient {
  private ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  /** Upload a file and wait until it's done processing. */
  async upload(path: string, mimeType?: string): Promise<File> {
    const mt = mimeType || detectMime(path);
    logger.debug(`[gemini] uploading ${basename(path)} (${mt})...`);
    let file = await this.ai.files.upload({ file: path, config: { mimeType: mt } });
    // Poll until ACTIVE (Gemini must process audio/video before generation).
    let tries = 0;
    while (file.state === "PROCESSING" && tries < 120) {
      await sleep(2000);
      file = await this.ai.files.get({ name: file.name! });
      tries++;
    }
    if (file.state === "FAILED") {
      throw new Error(`Gemini file processing failed: ${path}`);
    }
    logger.debug(`[gemini] uploaded ${basename(path)} → ${file.uri}`);
    return file;
  }

  /** Generate content from a prompt + uploaded files. */
  async generate(
    model: string,
    prompt: string,
    files: GeminiFileInput[],
    opts: GeminiGenerateOptions = {},
  ): Promise<GeminiResult> {
    const {
      maxRetries = 3,
      retryDelayMs = 2000,
      temperature = 0.2,
      maxOutputTokens = 65536,
      responseSchema,
      systemInstruction,
    } = opts;

    // Upload all files first; track for cleanup.
    const uploaded: File[] = [];
    try {
      for (const f of files) {
        uploaded.push(await this.upload(f.path, f.mimeType));
      }

      const config: Record<string, unknown> = {
        maxOutputTokens,
        temperature,
      };
      if (responseSchema) {
        config.responseMimeType = "application/json";
        config.responseSchema = responseSchema;
      }
      if (systemInstruction) config.systemInstruction = systemInstruction;

      const parts: Part[] = uploaded.map((f) => ({
        fileData: { fileUri: f.uri, mimeType: f.mimeType },
      }));
      parts.push({ text: prompt });

      let lastError: string | undefined;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const t0 = Date.now();
        try {
          const response = await this.ai.models.generateContent({
            model,
            contents: [{ role: "user", parts }],
            config,
          });
          const usage = response.usageMetadata || {};
          const text = response.text ?? "";
          const result = {
            text,
            usage: {
              inputTokens: usage.promptTokenCount ?? 0,
              outputTokens: usage.candidatesTokenCount ?? 0,
              totalTokens: usage.totalTokenCount ?? 0,
            },
          };
          logLlmCall({
            ts: new Date(t0).toISOString(),
            provider: "gemini",
            model,
            kind: opts.logKind,
            chunk: opts.logChunk,
            prompt,
            response: text,
            usage: result.usage,
            durationMs: Date.now() - t0,
            attempt: attempt + 1,
          });
          return result;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          logger.warn(`[gemini] attempt ${attempt + 1}/${maxRetries} failed: ${lastError}`);
          logLlmCall({
            ts: new Date(t0).toISOString(),
            provider: "gemini",
            model,
            kind: opts.logKind,
            chunk: opts.logChunk,
            prompt,
            response: "",
            durationMs: Date.now() - t0,
            attempt: attempt + 1,
            error: lastError,
          });
          if (attempt < maxRetries - 1) await sleep(retryDelayMs * (attempt + 1));
        }
      }
      return { text: "", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, error: lastError };
    } finally {
      await this.cleanup(uploaded);
    }
  }

  /** Generate and parse JSON (requires responseSchema in opts). */
  async generateJson<T = unknown>(
    model: string,
    prompt: string,
    files: GeminiFileInput[],
    responseSchema: Record<string, unknown>,
    opts: GeminiGenerateOptions = {},
  ): Promise<{ data: T | null; raw: string; usage: GeminiUsage; error?: string }> {
    const result = await this.generate(model, prompt, files, {
      ...opts,
      responseSchema,
    });
    if (result.error || !result.text) {
      return { data: null, raw: result.text, usage: result.usage, error: result.error };
    }
    try {
      // Strip markdown fences if present.
      let txt = result.text.trim();
      const fence = txt.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (fence && fence[1]) txt = fence[1];
      return { data: JSON.parse(txt) as T, raw: result.text, usage: result.usage };
    } catch (err) {
      return {
        data: null,
        raw: result.text,
        usage: result.usage,
        error: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async cleanup(files: File[]): Promise<void> {
    await Promise.allSettled(
      files.map(async (f) => {
        try {
          if (f.name) await this.ai.files.delete({ name: f.name });
        } catch {
          /* best-effort */
        }
      }),
    );
  }
}
