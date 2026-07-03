/**
 * Minimal logger with levels. No deps. A pluggable sink lets the CLI's pretty
 * renderer (utils/ui.ts) intercept the stream and turn it into spinners/colors
 * without the pipeline knowing — plain mode stays byte-identical.
 */
type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel: Level = "info";

/** Optional interceptor. Return true to swallow the line (sink rendered it). */
export type LogSink = (level: Level, msg: string) => boolean;
let sink: LogSink | null = null;

export function setLogLevel(level: Level): void {
  currentLevel = level;
}

function log(level: Level, msg: string, extra?: unknown): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return;
  if (sink && extra === undefined && sink(level, msg)) return;
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
  setSink: (s: LogSink | null) => {
    sink = s;
  },
};
