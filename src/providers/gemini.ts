/**
 * Gemini provider (multimodal). Handles file upload + processing poll, text and
 * structured-JSON generation, retries, token tracking, and uploaded-file cleanup.
 *
 * Uses `@google/genai` v1 SDK. Audio is uploaded via the Files API (supports large
 * files) and referenced by URI in the generate request.
 */
import {
  GoogleGenAI,
  type File,
  type GenerateContentResponseUsageMetadata,
  type Part,
} from "@google/genai";
import { basename } from "node:path";
import { logger } from "../utils/logger.js";
import { logLlmCall } from "./llm-log.js";
import { withRetry } from "../utils/retry.js";

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
  /** Checked against the accumulated text while the response streams; return a reason
   * to abort (e.g. a degenerate repetition loop). The call then fails fast with
   * `aborted: <reason>` instead of running to maxOutputTokens, and is NOT retried here —
   * repeating the identical request would likely loop again; the caller decides. */
  shouldAbort?: (textSoFar: string) => string | null;
}

export interface GeminiResult {
  text: string;
  usage: GeminiUsage;
  error?: string;
}

// The @google/genai SDK warns "Both GOOGLE_API_KEY and GEMINI_API_KEY are set..." on
// every client it builds internally — even though we always pass the key explicitly.
// Filter that exact line (and nothing else); having both env vars is our supported,
// documented setup.
const SDK_KEY_WARNING = "Both GOOGLE_API_KEY and GEMINI_API_KEY are set";
const originalWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith(SDK_KEY_WARNING)) return;
  originalWarn(...args);
};

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

/**
 * Per-model "thinking" configuration. The control is NOT uniform across the Gemini family,
 * and the wrong/default level makes some models (esp. 3.x **pro**) over-think long audio —
 * e.g. ~7x slower for transcription, which doesn't benefit from heavy reasoning. We tame it:
 *  - gemini-2.5-*  → `thinkingBudget` (flash can disable with 0; pro can't fully disable → 128)
 *  - gemini-3.x / *-latest → `thinkingLevel` (pro can't take MINIMAL → floor to LOW; flash MINIMAL)
 *  - gemini-2.0-*  → no thinking control
 * Returns the `thinkingConfig` fragment, or undefined when the model takes none.
 */
export function resolveThinking(model: string): Record<string, unknown> | undefined {
  const m = model.toLowerCase();
  if (m.includes("gemini-2.0")) return undefined;
  if (m.includes("gemini-2.5")) {
    return { thinkingBudget: m.includes("pro") ? 128 : 0 };
  }
  // 3.x (incl. gemini-3-*, gemini-3.1-*) and moving aliases like gemini-flash-latest /
  // gemini-pro-latest use thinkingLevel. Pro rejects MINIMAL, so floor it to LOW.
  if (m.includes("gemini-3") || m.includes("flash-latest") || m.includes("pro-latest")) {
    return { thinkingLevel: m.includes("pro") ? "LOW" : "MINIMAL" };
  }
  return undefined;
}

/** Whether an error message looks like the model rejected our thinking config. */
export function isThinkingConfigError(message: string | undefined): boolean {
  if (!message) return false;
  return (
    /thinking/i.test(message) &&
    /(not supported|invalid|unsupported|unknown name|unexpected)/i.test(message)
  );
}

export class GeminiClient {
  private ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  /** Upload a file and wait until it's done processing. Uploads ride one long HTTP
   * request each — the retry loop in generate() doesn't cover them, and transient
   * "fetch failed" blips here killed live runs, so they get their own retry. */
  async upload(path: string, mimeType?: string): Promise<File> {
    const mt = mimeType || detectMime(path);
    logger.debug(`[gemini] uploading ${basename(path)} (${mt})...`);
    let file = await withRetry(`gemini upload ${basename(path)}`, () =>
      this.ai.files.upload({ file: path, config: { mimeType: mt } }),
    );
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
      // Tame per-model thinking (keeps pro fast for transcription). Dropped automatically
      // if a model rejects it (see the catch below).
      const thinking = resolveThinking(model);
      if (thinking) config.thinkingConfig = thinking;

      const parts: Part[] = uploaded.map((f) => ({
        fileData: { fileUri: f.uri, mimeType: f.mimeType },
      }));
      parts.push({ text: prompt });

      let lastError: string | undefined;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const t0 = Date.now();
        try {
          // Streamed so the connection never sits silent: a non-streaming call sends no
          // response headers until generation finishes, and Node's fetch (undici) fails any
          // request whose headers take longer than 300s ("fetch failed") — long chunks and
          // runaway generations died there and were retried from scratch (field report 1).
          const controller = new AbortController();
          const stream = await this.ai.models.generateContentStream({
            model,
            contents: [{ role: "user", parts }],
            config: { ...config, abortSignal: controller.signal },
          });
          let text = "";
          let usageMeta: GenerateContentResponseUsageMetadata | undefined;
          let abortReason: string | null = null;
          for await (const chunk of stream) {
            text += chunk.text ?? "";
            if (chunk.usageMetadata) usageMeta = chunk.usageMetadata;
            abortReason = opts.shouldAbort?.(text) ?? null;
            if (abortReason) {
              controller.abort();
              break;
            }
          }
          const usage = {
            inputTokens: usageMeta?.promptTokenCount ?? 0,
            outputTokens: usageMeta?.candidatesTokenCount ?? 0,
            totalTokens: usageMeta?.totalTokenCount ?? 0,
          };
          const error = abortReason ? `aborted: ${abortReason}` : undefined;
          if (error) {
            logger.warn(
              `[gemini] ${opts.logKind ?? "call"}${opts.logChunk !== undefined ? ` chunk ${opts.logChunk}` : ""} ${error} after ${text.length} chars`,
            );
          }
          // Usage is logged for aborted calls too: the tokens streamed so far were paid for.
          logLlmCall({
            ts: new Date(t0).toISOString(),
            provider: "gemini",
            model,
            kind: opts.logKind,
            chunk: opts.logChunk,
            prompt,
            response: text,
            usage,
            durationMs: Date.now() - t0,
            attempt: attempt + 1,
            ...(error ? { error } : {}),
          });
          return error ? { text, usage, error } : { text, usage };
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          // If the model rejected our thinking config, drop it for all subsequent attempts
          // and retry (the next attempt then runs without any thinkingConfig).
          if (config.thinkingConfig && isThinkingConfigError(lastError)) {
            delete config.thinkingConfig;
            logger.warn(
              `[gemini] model ${model} rejected thinking config — retrying without it`,
            );
            continue;
          }
          logger.warn(
            `[gemini] attempt ${attempt + 1}/${maxRetries} failed: ${lastError}`,
          );
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
      return {
        text: "",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        error: lastError,
      };
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
