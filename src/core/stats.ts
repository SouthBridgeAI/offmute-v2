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
  rmdirSync,
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

/**
 * Tiny cross-process advisory lock (mkdir is atomic on every platform). Two CLI
 * processes finishing at the same moment must not lose each other's aggregate fold.
 * Held for microseconds; a stale lock (crashed process) is ignored after ~2s.
 */
function withStatsLock(dir: string, fn: () => void): void {
  const lock = join(dir, ".stats.lock");
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (Date.now() > deadline) break; // stale/contended — proceed rather than hang
      // Busy-wait a few ms; the critical section is sync and sub-millisecond.
      const until = Date.now() + 25;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
  try {
    fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      /* already gone */
    }
  }
}

/** Record a finished run: append to history, fold into aggregates. */
export function recordRun(rec: RunRecord, perModelCost: Record<string, number>): void {
  if (!statsEnabled()) return;
  try {
    const dir = statsDir();
    mkdirSync(dir, { recursive: true });
    // history.jsonl is the append-only source of truth (O_APPEND, one line per run).
    appendFileSync(join(dir, "history.jsonl"), JSON.stringify(rec) + "\n");

    withStatsLock(dir, () => {
      foldIntoAggregates(rec, perModelCost, dir);
    });
  } catch {
    /* stats are best-effort */
  }
}

function foldIntoAggregates(
  rec: RunRecord,
  perModelCost: Record<string, number>,
  dir: string,
): void {
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
}
