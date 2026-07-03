/**
 * Pretty CLI renderer: spinners, colored stages, and a live status line.
 *
 * Implemented as a LOGGER SINK rather than a pipeline rewrite: the pipeline keeps
 * logging exactly what it logs today (so plain mode, files, and the daemon are
 * byte-identical), and this module interprets that stream when the CLI runs on a TTY:
 *   - "=== stage ===" lines open a new spinner stage (previous one gets its ✓);
 *   - important lines (estimate, receipt, identify results, warnings) are promoted to
 *     permanent lines above the spinner;
 *   - everything else becomes the spinner's transient detail text.
 *
 * IMPORTANT: this module is imported by the CLI only — never by the library surface —
 * so chalk (ESM-only) stays out of the CJS library build.
 */
import chalk from "chalk";
import { logger } from "./logger.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK = chalk.green("✓");
const WARN = chalk.yellow("▲");
const FAIL = chalk.red("✗");

// ─── Shimmer ─────────────────────────────────────────────────────────────────
// The Claude Code / oh-my-pi "shimmer": re-render the string every frame with a
// brightness band sweeping across it at a FIXED cells-per-second velocity (so long
// labels don't shimmer faster), each char's intensity a cosine bump of its distance
// from the band crest, mapped to three color tiers. Same-tier runs are coalesced so
// a frame emits a handful of escape codes, not one per character.
const SHIMMER_SPEED_CELLS_PER_S = 25;
const SHIMMER_PADDING = 8; // band travels off both ends so the sweep "breathes"
const SHIMMER_HALF_WIDTH = 5;

function shimmer(text: string, now: number): string {
  const chars = [...text];
  const period = chars.length + SHIMMER_PADDING * 2;
  const pos = ((now / 1000) * SHIMMER_SPEED_CELLS_PER_S) % period;
  let out = "";
  let runTier = -1;
  let run = "";
  const flush = () => {
    if (!run) return;
    out += runTier === 2 ? chalk.bold.whiteBright(run) : runTier === 1 ? chalk.white(run) : chalk.dim(run);
    run = "";
  };
  for (let i = 0; i < chars.length; i++) {
    const dist = Math.abs(i + SHIMMER_PADDING - pos);
    const intensity = dist >= SHIMMER_HALF_WIDTH ? 0 : 0.5 * (1 + Math.cos((Math.PI * dist) / SHIMMER_HALF_WIDTH));
    const tier = intensity >= 0.65 ? 2 : intensity >= 0.2 ? 1 : 0;
    if (tier !== runTier) {
      flush();
      runTier = tier;
    }
    run += chars[i];
  }
  flush();
  return out;
}

/** Friendlier display names for pipeline stages. */
const STAGE_LABELS: Record<string, string> = {
  preprocess: "preparing media",
  describe: "listening for context",
  "llm-transcribe": "transcribing",
  align: "aligning timestamps",
  consistency: "resolving speakers",
  finalize: "finalizing",
  summary: "summarizing",
};

function stageLabel(raw: string): string {
  // "timestamped (AssemblyAI)" → "timestamps (AssemblyAI)"; "identify (x + y)" kept.
  if (raw.startsWith("timestamped")) return raw.replace("timestamped", "timestamps");
  if (raw.startsWith("identify")) return raw.replace("identify", "naming speakers");
  return STAGE_LABELS[raw] ?? raw;
}

interface StageState {
  label: string;
  startedAt: number;
  detail: string;
  chunksDone?: number;
  chunksTotal?: number;
}

let active = false;
let timer: ReturnType<typeof setInterval> | null = null;
let frame = 0;
let stage: StageState | null = null;
let lineDirty = false;

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s >= 60
    ? `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, "0")}s`
    : `${s}s`;
}

function clearLine(): void {
  if (lineDirty) {
    process.stdout.write("\r\x1b[2K");
    lineDirty = false;
  }
}

function drawSpinner(): void {
  if (!stage) return;
  const now = Date.now();
  const f = chalk.cyan(FRAMES[frame % FRAMES.length]);
  frame++;
  const elapsed = chalk.dim(fmtElapsed(now - stage.startedAt));
  const chunks =
    stage.chunksTotal !== undefined
      ? chalk.dim(` ${stage.chunksDone ?? 0}/${stage.chunksTotal} chunks`)
      : "";
  const detail = stage.detail ? chalk.dim(` · ${stage.detail}`) : "";
  const line = `${f} ${shimmer(stage.label, now)}${chunks}${detail} ${elapsed}`;
  process.stdout.write(`\r\x1b[2K${line}`);
  lineDirty = true;
}

/** Print a permanent line without corrupting the spinner. */
export function println(text = ""): void {
  clearLine();
  process.stdout.write(text + "\n");
  if (active && stage) drawSpinner();
}

function completeStage(): void {
  if (!stage) return;
  const dur = fmtElapsed(Date.now() - stage.startedAt);
  const chunks =
    stage.chunksTotal !== undefined
      ? chalk.dim(` · ${stage.chunksTotal} chunk${stage.chunksTotal === 1 ? "" : "s"}`)
      : "";
  const detail = stage.detail ? chalk.dim(` · ${stage.detail}`) : "";
  clearLine();
  process.stdout.write(`${TICK} ${stage.label}${chunks}${detail} ${chalk.dim(dur)}\n`);
  stage = null;
}

function startStage(rawName: string): void {
  completeStage();
  stage = { label: stageLabel(rawName), startedAt: Date.now(), detail: "" };
  drawSpinner();
}

/** Route one pipeline log line into the pretty renderer. */
function handleLine(level: "debug" | "info" | "warn" | "error", msg: string): void {
  if (level === "warn") {
    println(`${WARN} ${chalk.yellow(msg)}`);
    return;
  }
  if (level === "error") {
    println(`${FAIL} ${chalk.red(msg)}`);
    return;
  }

  const stageMatch = msg.match(/^=== (.+) ===$/);
  if (stageMatch) {
    startStage(stageMatch[1]!);
    return;
  }

  // Chunk accounting for the transcribe stage.
  const totalMatch = msg.match(/^(\d+) chunks \(/);
  if (totalMatch && stage) {
    stage.chunksTotal = parseInt(totalMatch[1]!, 10);
    stage.chunksDone = 0;
    return;
  }
  if (
    /^\[llm\] chunk \d+ ok|^chunk \d+: cached/.test(msg) &&
    stage?.chunksTotal !== undefined
  ) {
    stage.chunksDone = (stage.chunksDone ?? 0) + 1;
    drawSpinner();
    return;
  }

  // Lines worth keeping on screen.
  if (msg.startsWith("estimated cost")) {
    const pretty = msg.replace(
      /^estimated cost (~\$[\d.]+)(.*)$/,
      (_, amt: string, rest: string) =>
        `${chalk.bold("estimate")} ${chalk.yellow(amt)}${chalk.dim(rest)}`,
    );
    println(`  ${pretty}`);
    return;
  }
  if (msg.startsWith("receipt:")) {
    // The receipt is a terminal event — close the last stage so ✓ lines stay ordered.
    completeStage();
    println(`  ${chalk.bold("receipt")} ${chalk.yellow(msg.slice(9))}`);
    return;
  }
  if (msg.startsWith("  ") && /\$\d/.test(msg)) {
    println(chalk.dim(`   ${msg.trim()}`));
    return;
  }
  if (msg.startsWith("identified ") || msg.startsWith("identify:")) {
    println(`  ${chalk.magenta("◆")} ${msg}`);
    return;
  }
  if (msg.startsWith("description:")) {
    const text = msg.slice(12).trim().replace(/\s+/g, " ");
    println(
      chalk.dim(`  ${text.slice(0, Math.max(40, (process.stdout.columns || 100) - 4))}`),
    );
    return;
  }
  if (msg.startsWith("intermediates:")) {
    const p = msg.slice(14).trim().split("  (file://")[0];
    println(chalk.dim(`  cache ${p}`));
    return;
  }
  if (msg.startsWith("outputs written")) {
    return; // the CLI prints its own outputs block
  }

  // Everything else: transient spinner detail (de-noised).
  if (stage) {
    stage.detail = msg
      .replace(/^\[[a-z-]+\]\s*/i, "") // "[assemblyai] uploading…" → "uploading…"
      .replace(/^cache hit \S+$/, "cached")
      .replace(/\.{3}$/, "")
      .slice(0, 60);
    drawSpinner();
  }
}

export interface UiOptions {
  enabled: boolean;
}

/** Turn the pretty renderer on (TTY CLI runs) or leave logging as-is. */
export function configureUi(opts: UiOptions): void {
  active = opts.enabled;
  if (!active) return;
  logger.setSink((level, msg) => {
    handleLine(level, msg);
    return true; // swallow the plain line
  });
  // ~15fps: the shimmer advances ≤2 cells per frame at 25 cells/s — smooth without
  // burning CPU on a transcription tool.
  timer = setInterval(() => {
    if (stage) drawSpinner();
  }, 66);
  timer.unref();
}

export function uiActive(): boolean {
  return active;
}

/** Finish: complete any open stage and stop the spinner. */
export function finishUi(): void {
  if (!active) return;
  completeStage();
  clearLine();
  if (timer) clearInterval(timer);
  timer = null;
  active = false;
  logger.setSink(null);
}

// ---------------------------------------------------------------------------
// Blocks the CLI prints directly (banner, outputs, tips, errors).

export function banner(version: string, inputName: string): void {
  if (!active) return;
  process.stdout.write(
    `\n${chalk.bold.cyan("offmute")}${chalk.dim("-v2")} ${chalk.dim(version)}  ${chalk.bold(inputName)}\n\n`,
  );
}

export function outputsBlock(files: string[], summaryLine: string): void {
  clearLine();
  process.stdout.write("\n");
  for (const f of files) {
    process.stdout.write(`  ${chalk.green("→")} ${f}\n`);
  }
  process.stdout.write(`\n${chalk.bold(summaryLine)}\n`);
}

export function tipsBlock(tips: string[]): void {
  if (tips.length === 0) return;
  process.stdout.write("\n");
  for (const t of tips) {
    process.stdout.write(chalk.dim(`  tip: ${t}\n`));
  }
}

/** One quiet line of horn-tooting at the very end. */
export function starFooter(): void {
  process.stdout.write(
    chalk.dim(
      `\n  state-of-the-art open diarization · if it earned it: ${chalk.reset.dim.underline("github.com/SouthBridgeAI/offmute-v2")} ${chalk.yellow("★")}\n`,
    ),
  );
}

export function errorBlock(message: string, hint?: string): void {
  clearLine();
  if (timer) clearInterval(timer);
  if (stage) {
    // The open stage FAILED — mark it so, never tick it.
    process.stderr.write(
      `${FAIL} ${stage.label} ${chalk.dim(fmtElapsed(Date.now() - stage.startedAt))}\n`,
    );
    stage = null;
  }
  process.stderr.write(`\n${FAIL} ${chalk.red(message)}\n`);
  if (hint) process.stderr.write(chalk.dim(`  ${hint}\n`));
}
