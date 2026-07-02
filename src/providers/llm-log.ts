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

/** In-memory usage collector for the current run (powers the cost receipt).
 * Collected regardless of whether file logging is enabled. */
export interface LlmUsageRecord {
  provider: string;
  model: string;
  kind?: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  errors: number;
}
let usageRecords: Map<string, LlmUsageRecord> = new Map();

/** Set the destination JSONL path (call once at pipeline start). Pass null/undefined to disable. */
export function setLlmLogPath(path: string | null | undefined): void {
  logPath = path ?? null;
}

export function llmLogPath(): string | null {
  return logPath;
}

/** Reset the per-run usage collector (call at pipeline start). */
export function resetLlmUsage(): void {
  usageRecords = new Map();
}

/** Aggregated usage by model+kind for the current run. */
export function getLlmUsage(): LlmUsageRecord[] {
  return [...usageRecords.values()];
}

/** Append an LLM call record. File write is a no-op if no path is set; usage is
 * always collected in memory. Best-effort (never throws). */
export function logLlmCall(entry: LlmLogEntry): void {
  try {
    const key = `${entry.model}|${entry.kind ?? ""}`;
    const rec = usageRecords.get(key) ?? {
      provider: entry.provider,
      model: entry.model,
      kind: entry.kind,
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      errors: 0,
    };
    rec.inputTokens += entry.usage?.inputTokens ?? 0;
    rec.outputTokens += entry.usage?.outputTokens ?? 0;
    rec.calls += 1;
    if (entry.error) rec.errors += 1;
    usageRecords.set(key, rec);
  } catch {
    /* never break the pipeline */
  }
  if (!logPath) return;
  try {
    appendFileSync(logPath, JSON.stringify(entry) + "\n", { encoding: "utf-8" });
  } catch {
    /* logging must never break the pipeline */
  }
}
