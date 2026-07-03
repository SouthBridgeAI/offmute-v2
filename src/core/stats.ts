/**
 * Lifetime stats in ~/.offmute: history.jsonl (one record per run) + stats.json
 * (aggregates: hours processed, characters emitted, cost by model, run count).
 * Best-effort — stats must never break a transcription. Opt out: OFFMUTE_NO_STATS=1.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RunRecord {
  ts: string;
  input: string;
  durationSec: number;
  wallMs: number;
  models: Record<string, string>;
  segments: number;
  characters: number;
  speakers: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface LifetimeStats {
  runs: number;
  mediaSeconds: number;
  characters: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costByModel: Record<string, number>;
  runsByModel: Record<string, number>;
  firstRun?: string;
  lastRun?: string;
}

export function statsDir(): string {
  return process.env.OFFMUTE_HOME || join(homedir(), ".offmute");
}

function statsEnabled(): boolean {
  return !process.env.OFFMUTE_NO_STATS;
}

const EMPTY: LifetimeStats = {
  runs: 0,
  mediaSeconds: 0,
  characters: 0,
  llmCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  costByModel: {},
  runsByModel: {},
};

export function readStats(): LifetimeStats {
  try {
    const p = join(statsDir(), "stats.json");
    if (!existsSync(p)) return { ...EMPTY };
    return { ...EMPTY, ...(JSON.parse(readFileSync(p, "utf-8")) as LifetimeStats) };
  } catch {
    return { ...EMPTY };
  }
}

/** Record a finished run: append to history, fold into aggregates. */
export function recordRun(rec: RunRecord, perModelCost: Record<string, number>): void {
  if (!statsEnabled()) return;
  try {
    const dir = statsDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "history.jsonl"), JSON.stringify(rec) + "\n");

    const s = readStats();
    s.runs += 1;
    s.mediaSeconds += rec.durationSec;
    s.characters += rec.characters;
    s.llmCalls += rec.llmCalls;
    s.inputTokens += rec.inputTokens;
    s.outputTokens += rec.outputTokens;
    if (rec.costUsd !== null) s.costUsd += rec.costUsd;
    for (const [model, usd] of Object.entries(perModelCost)) {
      s.costByModel[model] = (s.costByModel[model] ?? 0) + usd;
    }
    const tModel = rec.models.transcribe;
    if (tModel) s.runsByModel[tModel] = (s.runsByModel[tModel] ?? 0) + 1;
    s.firstRun ??= rec.ts;
    s.lastRun = rec.ts;
    writeFileSync(join(dir, "stats.json"), JSON.stringify(s, null, 2));
  } catch {
    /* stats are best-effort */
  }
}
