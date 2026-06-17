/**
 * Minimal logger with levels. No deps. Swappable for a richer logger later.
 */
type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel: Level = "info";

export function setLogLevel(level: Level): void {
  currentLevel = level;
}

function log(level: Level, msg: string, extra?: unknown): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return;
  const ts = new Date().toISOString().substring(11, 23);
  const prefix = `[${ts}] ${level.toUpperCase().padEnd(5)}`;
  if (extra !== undefined) {
    console[level === "error" ? "error" : "log"](prefix, msg, extra);
  } else {
    console[level === "error" ? "error" : "log"](prefix, msg);
  }
}

export const logger = {
  debug: (msg: string, extra?: unknown) => log("debug", msg, extra),
  info: (msg: string, extra?: unknown) => log("info", msg, extra),
  warn: (msg: string, extra?: unknown) => log("warn", msg, extra),
  error: (msg: string, extra?: unknown) => log("error", msg, extra),
  setLevel: setLogLevel,
};
