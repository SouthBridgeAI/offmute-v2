/**
 * First run of a new version: a fast, offline setup check (key presence only — no
 * network pings; `offmute-v2 doctor` does the live version) plus "what you'd unlock"
 * hints for the keys that are missing. Tracked via ~/.offmute/last-version.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { resolveKeys } from "../core/config.js";
import { statsDir } from "../core/stats.js";

export function maybeFirstRunCheck(version: string): boolean {
  let last: string | null = null;
  const dir = statsDir();
  const path = join(dir, "last-version");
  try {
    if (existsSync(path)) last = readFileSync(path, "utf-8").trim();
  } catch {
    /* treat as first run */
  }
  if (last === version) return false;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, version);
  } catch {
    /* still show the check */
  }

  const keys = resolveKeys();
  const have = (k: string | undefined) => (k ? chalk.green("✓") : chalk.dim("–"));
  const lines: string[] = [];
  lines.push(
    chalk.dim(
      `first run of ${chalk.reset.bold(version)}${chalk.dim(" — checking your setup (offline; `offmute-v2 doctor` pings live)")}`,
    ),
  );
  lines.push(`  ${have(keys.gemini)} GEMINI_API_KEY        ${chalk.dim("transcription — required")}`);
  lines.push(`  ${have(keys.assemblyai)} ASSEMBLYAI_API_KEY    ${chalk.dim("word-accurate timestamps (default clock)")}`);
  lines.push(`  ${have(keys.elevenlabs)} ELEVENLABS_API_KEY    ${chalk.dim("Scribe v2 — sharpest diarization (--timestamped elevenlabs)")}`);
  lines.push(`  ${have(keys.deepseek)} DEEPSEEK_API_KEY      ${chalk.dim("cheapest speaker-naming reasoner")}`);
  lines.push(`  ${have(keys.groq)} GROQ_API_KEY          ${chalk.dim("free/fast whisper timing fallback")}`);

  const unlocks: string[] = [];
  if (!keys.gemini)
    unlocks.push("set GEMINI_API_KEY (or GOOGLE_API_KEY) — nothing works without ears: https://aistudio.google.com/apikey");
  if (!keys.assemblyai && !keys.elevenlabs && !keys.groq)
    unlocks.push("add ASSEMBLYAI_API_KEY for word-accurate timestamps (timestamps are coarse without a clock)");
  if (keys.assemblyai && !keys.elevenlabs)
    unlocks.push("add ELEVENLABS_API_KEY to try Scribe v2 — the sharpest speaker separation we've tested on conversational audio");
  if (!keys.deepseek) unlocks.push("add DEEPSEEK_API_KEY so speaker naming costs ~$0.003 a run");
  for (const u of unlocks.slice(0, 2)) lines.push(chalk.dim(`  unlock: ${u}`));

  process.stdout.write(lines.join("\n") + "\n\n");
  return true;
}
