/**
 * The CLI's live display on a terminal.
 *
 * Driven by the pipeline's progress events (core/progress.ts). The log stream still
 * reaches it through a logger sink, for what no event carries: warnings, the meeting's
 * one-line description, where the cache is, and the receipt. Plain runs (piped output,
 * `--log-level debug`, the watch daemon) never turn it on and print the logs as they are.
 *
 * Finished steps stay on screen as ✓ lines. Below them, a live area is redrawn about
 * twelve times a second: the running step with a small level meter (the tool is
 * listening) and its time, one cell per chunk while transcribing, and a second lane for
 * the timing ASR while it works alongside.
 *
 * Imported by the CLI only, never by the library surface, so chalk (ESM-only) stays out
 * of the CJS library build.
 */
import chalk from "chalk";
import { stripVTControlCharacters } from "node:util";
import { logger } from "./logger.js";
import { compactTime } from "../finalize/format.js";
import type { ProgressEvent, StageName } from "../core/progress.js";

const TICK = chalk.green("✓");
const WARN = chalk.yellow("▲");
const FAIL = chalk.red("✗");
const DOT = chalk.dim(" · ");

/** Each step's line while it runs and once it's done. */
const STAGES: Record<StageName, { doing: string; done: string }> = {
  preprocess: { doing: "preparing the media", done: "prepared the media" },
  describe: { doing: "listening for who's there", done: "listened for who's there" },
  transcribe: { doing: "transcribing", done: "transcribed" },
  align: {
    doing: "matching lines to the word times",
    done: "matched lines to the word times",
  },
  speakers: { doing: "telling the voices apart", done: "told the voices apart" },
  identify: { doing: "naming the speakers", done: "named the speakers" },
  finalize: { doing: "finishing", done: "finished" },
  summary: { doing: "writing the summary", done: "wrote the summary" },
};

// ─── Animation ──────────────────────────────────────────────────────────────

/** A three-bar level meter, the spinner: the tool is listening. Two slow sines per bar
 * keep it from looking like a loop. */
const BARS = "▁▂▃▄▅▆▇█";
function meter(now: number, phase: number, paint: (s: string) => string): string {
  let bars = "";
  for (let i = 0; i < 3; i++) {
    const level =
      0.5 + 0.5 * Math.sin(now / 150 + phase + i * 2.1) * Math.sin(now / 420 + i * 1.3);
    bars += BARS.charAt(Math.round(level * 7));
  }
  return paint(bars);
}

// The shimmer from Claude Code and oh-my-pi: a band of brightness sweeping across the
// running step's words at a fixed speed in cells per second (so a long label doesn't sweep
// faster). Each character's intensity is a cosine bump of its distance from the crest,
// mapped to dim, plain and bold, which read on light and dark terminals alike. Runs of one
// tier are coalesced, so a frame costs a few escape codes.
const SHIMMER_CELLS_PER_S = 25;
const SHIMMER_PADDING = 8;
const SHIMMER_HALF_WIDTH = 5;
function shimmer(text: string, now: number): string {
  const chars = [...text];
  const period = chars.length + SHIMMER_PADDING * 2;
  const crest = ((now / 1000) * SHIMMER_CELLS_PER_S) % period;
  let out = "";
  let run = "";
  let runTier = -1;
  const flush = () => {
    if (run)
      out += runTier === 2 ? chalk.bold(run) : runTier === 1 ? run : chalk.dim(run);
    run = "";
  };
  chars.forEach((ch, i) => {
    const dist = Math.abs(i + SHIMMER_PADDING - crest);
    const intensity =
      dist >= SHIMMER_HALF_WIDTH
        ? 0
        : 0.5 * (1 + Math.cos((Math.PI * dist) / SHIMMER_HALF_WIDTH));
    const tier = intensity >= 0.65 ? 2 : intensity >= 0.2 ? 1 : 0;
    if (tier !== runTier) {
      flush();
      runTier = tier;
    }
    run += ch;
  });
  flush();
  return out;
}

/** "offmute" shaded teal to green, the frog's colours (plain bold where colour is off). */
function wordmark(): string {
  const letters = [..."offmute"];
  return letters
    .map((ch, i) => {
      const t = i / (letters.length - 1);
      // teal (20,184,166) → green (101,163,13): mid-tones that read on light and dark.
      return chalk.bold.rgb(
        Math.round(20 + 81 * t),
        Math.round(184 - 21 * t),
        Math.round(166 - 153 * t),
      )(ch);
    })
    .join("");
}

// ─── Chunk cells ────────────────────────────────────────────────────────────

type Cell =
  | "pending"
  | "running"
  | "done"
  | "cached"
  | "failed"
  | "retrying"
  | "recovered"
  | "unchanged";

/** A working cell breathes, each a little out of step with its neighbour. */
const breathe = (now: number, i: number) => Math.sin(now / 130 - i * 0.8) > 0;
const CELLS: Record<Cell, (now: number, i: number) => string> = {
  pending: () => chalk.dim("▱"),
  running: (now, i) => (breathe(now, i) ? chalk.cyan("▰") : chalk.cyan("▱")),
  done: () => chalk.green("▰"),
  cached: () => chalk.green.dim("▰"),
  failed: () => chalk.red("▰"),
  retrying: (now, i) => (breathe(now, i) ? chalk.yellow("▰") : chalk.yellow("▱")),
  recovered: () => chalk.yellow("▰"),
  unchanged: () => chalk.red("▰"),
};
/** Past this many chunks (over eight hours of audio), only the count is shown. */
const MAX_CELLS = 48;

// ─── State ──────────────────────────────────────────────────────────────────

let active = false;
let timer: NodeJS.Timeout | undefined;
/** Rows of the live area on screen now. */
let liveRows = 0;
/** The running step. `detail` stays on its ✓ line (the reasoners naming speakers);
 * `status` shows only while it runs ("extracting audio"). */
let lane: { stage: StageName; startedAt: number; detail: string; status: string } | null =
  null;
/** The timing ASR, while it works. */
let asr: { provider: string; startedAt: number } | null = null;
/** The timing ASR's name, from the plan, for the coverage check's lines. */
let clockName = "the timing ASR";
let cellsTotal = 0;
const cells = new Map<number, Cell>();
let redone = 0;
const restoreConsole: (() => void)[] = [];

// ─── Terminal ───────────────────────────────────────────────────────────────

/** Columns a code point takes: two for wide East Asian scripts and emoji, none for
 * combining marks and joiners. */
function cellWidth(cp: number): number {
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f)
  ) {
    return 0;
  }
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd);
  return wide ? 2 : 1;
}

function columnsOf(text: string): number {
  let n = 0;
  for (const ch of stripVTControlCharacters(text)) n += cellWidth(ch.codePointAt(0)!);
  return n;
}

const ESCAPE_AT = /\x1b\[[0-9;?]*[A-Za-z]/y;

/** Cut a styled line short of `max` columns, keeping its colours. A live line that wrapped
 * would break the redraw, which moves the cursor up one row per line. */
function fit(line: string, max: number): string {
  if (columnsOf(line) < max) return line;
  let out = "";
  let used = 0;
  for (let i = 0; i < line.length; ) {
    ESCAPE_AT.lastIndex = i;
    const escape = ESCAPE_AT.exec(line);
    if (escape) {
      out += escape[0];
      i = ESCAPE_AT.lastIndex;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    const w = cellWidth(ch.codePointAt(0)!);
    if (used + w > max - 2) break;
    out += ch;
    used += w;
    i += ch.length;
  }
  return `${out}\x1b[0m${chalk.dim("…")}`;
}

const columns = () => Math.max(20, process.stdout.columns || 100);

/** Erase the live area; the cursor ends where its first row was. */
function eraseLive(): string {
  if (liveRows === 0) return "";
  const up = liveRows > 1 ? `\x1b[${liveRows - 1}A` : "";
  liveRows = 0;
  return `${up}\r\x1b[0J`;
}

function draw(): void {
  if (!active) return;
  const lines = liveLines(Date.now()).map((l) => fit(l, columns()));
  process.stdout.write(eraseLive() + lines.join("\n"));
  liveRows = lines.length;
}

/** Print a lasting line above the live area. */
function println(text = ""): void {
  process.stdout.write(`${eraseLive()}${text}\n`);
  draw();
}

// ─── Lines ──────────────────────────────────────────────────────────────────

function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

function audioLength(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  return `${Math.floor(sec / 3600)}h ${String(Math.round((sec % 3600) / 60)).padStart(2, "0")}m`;
}

const count = (n: number) => n.toLocaleString("en-US");

function languageName(code: string | undefined): string | undefined {
  if (!code) return undefined;
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function strip(now: number): string {
  if (cellsTotal === 0 || cellsTotal > MAX_CELLS) return "";
  let out = "";
  for (let i = 0; i < cellsTotal; i++) out += CELLS[cells.get(i) ?? "pending"](now, i);
  return `  ${out}`;
}

function chunkTally(): string {
  const states = [...cells.values()];
  const working = states.filter((c) => c === "running" || c === "retrying").length;
  return chalk.dim(
    `  ${states.length - working}/${cellsTotal} chunk${cellsTotal === 1 ? "" : "s"}${working ? ` · ${working} running` : ""}`,
  );
}

function liveLines(now: number): string[] {
  const lines: string[] = [];
  if (lane) {
    const mid =
      lane.stage === "transcribe" && cellsTotal > 0
        ? `${strip(now)}${chunkTally()}`
        : lane.status || lane.detail
          ? chalk.dim(` · ${lane.status || lane.detail}`)
          : "";
    lines.push(
      `${meter(now, 0, chalk.cyan)} ${shimmer(STAGES[lane.stage].doing, now)}${mid}  ${chalk.dim(elapsed(now - lane.startedAt))}`,
    );
  }
  if (asr) {
    lines.push(
      `${meter(now, 1.7, chalk.magenta)} ${chalk.dim(`timing every word · ${asr.provider}  ${elapsed(now - asr.startedAt)}`)}`,
    );
  }
  return lines;
}

/** Close the running step with its ✓ line. */
function completeLane(): void {
  if (!lane) return;
  const now = Date.now();
  const { stage, startedAt, detail } = lane;
  lane = null;
  let mid = detail ? chalk.dim(` · ${detail}`) : "";
  if (stage === "transcribe" && cellsTotal > 0) {
    mid = `${strip(now)}${chalk.dim(
      `  ${cellsTotal} chunk${cellsTotal === 1 ? "" : "s"}${redone ? ` · ${redone} redone in halves` : ""}`,
    )}`;
  }
  println(`${TICK} ${STAGES[stage].done}${mid}  ${chalk.dim(elapsed(now - startedAt))}`);
}

const span = (startSec: number, endSec: number) =>
  `${compactTime(startSec)}–${compactTime(endSec)}`;

// ─── Events ─────────────────────────────────────────────────────────────────

/** The listener the CLI hands to `transcribe({ onProgress })`. */
export function onProgress(e: ProgressEvent): void {
  if (!active) return;
  switch (e.type) {
    case "plan": {
      // The plan needs the probed media, so preparing it is done.
      completeLane();
      if (e.asr !== "none") clockName = e.asr;
      const bits = [
        `${chalk.bold(audioLength(e.durationSec))} of audio`,
        chalk.cyan(e.model),
        e.asr === "none" ? chalk.yellow("the LLM's own timestamps") : `timed by ${e.asr}`,
        `${chalk.yellow(`~$${e.estimateUsd.toFixed(2)}`)} estimated`,
      ];
      println(`  ${bits.join(DOT)}`);
      if (e.zeroStorage) {
        const unasked = e.notAsked.map((p) => p.name).join(", ");
        println(
          `  ${chalk.green("zero storage")}${unasked ? chalk.dim(` · ${unasked} can't be asked to keep nothing`) : ""}`,
        );
      }
      println();
      return;
    }
    case "stage":
      if (e.state === "failed") {
        // The run goes on without it: mark the step failed, never tick it.
        if (lane?.stage === e.stage) {
          const took = elapsed(Date.now() - lane.startedAt);
          lane = null;
          println(`${FAIL} ${STAGES[e.stage].doing} failed  ${chalk.dim(took)}`);
        }
        return;
      }
      completeLane();
      if (e.state === "cached") {
        println(`${TICK} ${STAGES[e.stage].done}${chalk.dim(" · from the cache")}`);
        return;
      }
      lane = {
        stage: e.stage,
        startedAt: Date.now(),
        detail: e.detail ?? "",
        status: "",
      };
      draw();
      return;
    case "asr": {
      if (e.state === "start") {
        asr = { provider: e.provider, startedAt: Date.now() };
        draw();
        return;
      }
      const took = asr ? `  ${chalk.dim(elapsed(Date.now() - asr.startedAt))}` : "";
      asr = null;
      if (e.state === "failed") {
        println(
          `${FAIL} timing every word · ${e.provider} failed${chalk.dim(" · the run stops when transcription ends; finished chunks stay cached")}`,
        );
        return;
      }
      const facts = [
        e.words !== undefined && `${count(e.words)} words`,
        e.speakers && `${e.speakers} voices`,
        languageName(e.language),
        e.state === "cached" && "from the cache",
      ].filter(Boolean);
      println(
        `${TICK} timed every word · ${e.provider}${chalk.dim(facts.map((f) => ` · ${f}`).join(""))}${took}`,
      );
      return;
    }
    case "chunks":
      cellsTotal = e.total;
      cells.clear();
      redone = 0;
      draw();
      return;
    case "chunk":
      cells.set(e.index, e.state);
      if (e.state === "failed") {
        println(`${FAIL} chunk ${e.index + 1}: ${chalk.red(e.error ?? "failed")}`);
      }
      draw();
      return;
    case "guard": {
      const where = span(e.startSec, e.endSec);
      if (e.state === "retrying") {
        cells.set(e.index, "retrying");
        println(
          `  ${chalk.yellow("↻")} ${where} came back short${chalk.dim(` · ${count(e.llmWords)} words where ${clockName} heard ${count(e.asrWords)}`)} · transcribing it again in two halves`,
        );
      } else if (e.state === "recovered") {
        cells.set(e.index, "recovered");
        redone++;
        println(
          `  ${TICK} ${where} recovered${chalk.dim(` · ${count(e.retryWords ?? 0)} words`)}`,
        );
      } else {
        cells.set(e.index, "unchanged");
        println(
          `  ${WARN} ${where}: the halves did no better${chalk.dim(` · kept the first attempt; ${clockName}'s words fill its gaps`)}`,
        );
      }
      draw();
      return;
    }
    case "names": {
      const pairs = Object.entries(e.names);
      if (pairs.length) {
        println(
          `  ${chalk.magenta("◆")} ${pairs.map(([id, name]) => `${chalk.dim(`${id} →`)} ${chalk.bold(name)}`).join(DOT)}`,
        );
      }
      return;
    }
    case "done":
      completeLane();
      return;
  }
}

// ─── Log lines ──────────────────────────────────────────────────────────────

/** What the log says that no event does. Other info lines stay in the logs (a plain run,
 * or --log-level debug, shows them all). */
function handleLine(level: "debug" | "info" | "warn" | "error", msg: string): void {
  if (level === "error") {
    println(`${FAIL} ${chalk.red(msg)}`);
    return;
  }
  if (level === "warn") {
    // The coverage check's retry has its own line, from its event.
    if (!msg.includes("transcribing it again in two halves")) {
      println(`${WARN} ${chalk.yellow(msg)}`);
    }
    return;
  }
  if (msg.startsWith("description:")) {
    // Describing is over once it has said what it heard.
    completeLane();
    println(fit(chalk.dim(`  ${msg.slice(12).trim().replace(/\s+/g, " ")}`), columns()));
    return;
  }
  if (msg.startsWith("intermediates:")) {
    println(chalk.dim(`  cache ${msg.slice(14).trim().split("  (file://")[0]}`));
    return;
  }
  if (msg.startsWith("identify:")) {
    println(`  ${chalk.magenta("◆")} ${chalk.dim(msg.slice(9).trim())}`);
    return;
  }
  if (msg.startsWith("receipt:")) {
    completeLane();
    println(`\n  ${chalk.bold("receipt")} ${chalk.yellow(msg.slice(9))}`);
    return;
  }
  if (msg.startsWith("  ") && /\$\d/.test(msg)) {
    println(chalk.dim(`     ${msg.trim()}`));
    return;
  }
  if (lane?.stage === "preprocess" && msg.startsWith("extracting ")) {
    lane.status = msg.replace(/ \(.*\)/, "").replace(/\.{3}$/, "");
    draw();
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

const showCursor = () => process.stdout.write("\x1b[?25h");

function stopOnSignal(signal: NodeJS.Signals): void {
  process.stdout.write(eraseLive());
  showCursor();
  process.stdout.write(
    `\n${WARN} ${chalk.yellow("stopped")}${chalk.dim(" · what finished is cached; run the same command again to carry on")}\n`,
  );
  process.exit(signal === "SIGINT" ? 130 : 143);
}

/** Turn the live display on (a TTY run of the CLI) or leave logging as it is. */
export function configureUi(opts: { enabled: boolean }): void {
  active = opts.enabled;
  if (!active) return;
  logger.setSink((level, msg) => {
    handleLine(level, msg);
    return true;
  });
  // Anything else printing (an SDK's warning) lands above the live area, not inside it.
  for (const name of ["log", "info", "warn", "error"] as const) {
    const original = console[name];
    console[name] = (...args: unknown[]) => {
      process.stdout.write(eraseLive());
      original(...args);
      draw();
    };
    restoreConsole.push(() => {
      console[name] = original;
    });
  }
  process.stdout.write("\x1b[?25l");
  process.once("exit", showCursor);
  process.once("SIGINT", stopOnSignal);
  process.once("SIGTERM", stopOnSignal);
  timer = setInterval(draw, 80);
  timer.unref();
}

export function uiActive(): boolean {
  return active;
}

/** Finish: close the running step, clear the live area, put everything back. */
export function finishUi(): void {
  if (!active) return;
  completeLane();
  asr = null;
  process.stdout.write(eraseLive());
  clearInterval(timer);
  timer = undefined;
  for (const restore of restoreConsole.splice(0)) restore();
  process.removeListener("SIGINT", stopOnSignal);
  process.removeListener("SIGTERM", stopOnSignal);
  showCursor();
  active = false;
  logger.setSink(null);
}

// ─── Blocks the CLI prints itself ───────────────────────────────────────────

export function banner(version: string, inputName: string): void {
  if (!active) return;
  println(
    `\n${wordmark()}${chalk.dim("-v2")} ${chalk.dim(version)}  ${chalk.bold(inputName)}`,
  );
}

/** The end of a run: what it made and where. */
export function outputsBlock(files: string[], summaryLine: string): void {
  process.stdout.write(`\n${TICK} ${chalk.bold(summaryLine)}\n\n`);
  for (const f of files) {
    const slash = f.lastIndexOf("/");
    process.stdout.write(
      `  ${chalk.green("→")} ${chalk.dim(f.slice(0, slash + 1))}${chalk.bold(f.slice(slash + 1))}\n`,
    );
  }
}

export function tipsBlock(tips: string[]): void {
  if (tips.length === 0) return;
  process.stdout.write("\n");
  for (const t of tips) process.stdout.write(`  ${chalk.cyan("tip")} ${chalk.dim(t)}\n`);
}

/** One quiet line at the very end. */
export function starFooter(): void {
  process.stdout.write(
    chalk.dim(
      `\n  state-of-the-art open diarization · if it earned it: ${chalk.reset.dim.underline("github.com/SouthBridgeAI/offmute-v2")} ${chalk.yellow("★")}\n`,
    ),
  );
}

export function errorBlock(message: string, hint?: string): void {
  process.stdout.write(eraseLive());
  if (lane) {
    // The running step is the one that failed: mark it so, never tick it.
    process.stderr.write(
      `${FAIL} ${STAGES[lane.stage].doing}  ${chalk.dim(elapsed(Date.now() - lane.startedAt))}\n`,
    );
    lane = null;
  }
  asr = null;
  process.stderr.write(`\n${FAIL} ${chalk.red(message)}\n`);
  if (hint) process.stderr.write(chalk.dim(`  ${hint}\n`));
}
