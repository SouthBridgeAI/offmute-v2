/**
 * LLM call logger: appends one JSON line per LLM call (provider, model, kind, prompt,
 * response, usage, timing, error) to a JSONL file so every call can be validated.
 *
 * The pipeline sets the log path once at start (via setLlmLogPath); providers call
 * logLlmCall() after each call. If no path is set (e.g. browser, or logging disabled),
 * logLlmCall is a no-op.
 */
import { appendFileSync } from "node:fs";

export interface LlmLogEntry {
  ts: string;
  provider: string;
  model: string;
  /** What this call was for, e.g. "describe" | "transcribe" | "identify". */
  kind?: string;
  /** Chunk index for transcription calls. */
  chunk?: number;
  prompt: string;
  response: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number };
  durationMs: number;
  attempt?: number;
  error?: string;
}

let logPath: string | null = null;

/** Set the destination JSONL path (call once at pipeline start). Pass null/undefined to disable. */
export function setLlmLogPath(path: string | null | undefined): void {
  logPath = path ?? null;
}

export function llmLogPath(): string | null {
  return logPath;
}

/** Append an LLM call record. No-op if no path is set. Best-effort (never throws). */
export function logLlmCall(entry: LlmLogEntry): void {
  if (!logPath) return;
  try {
    appendFileSync(logPath, JSON.stringify(entry) + "\n", { encoding: "utf-8" });
  } catch {
    /* logging must never break the pipeline */
  }
}
