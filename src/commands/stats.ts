/**
 * `offmute-v2 stats` — lifetime numbers from ~/.offmute: how much you've
 * transcribed, what it cost, which models did the work.
 */
import { readStats, statsDir } from "../core/stats.js";
import { formatDuration } from "../utils/time.js";

export function runStats(): void {
  const s = readStats();
  if (s.runs === 0) {
    console.log(`\nNo runs recorded yet (stats live in ${statsDir()}).\n`);
    return;
  }
  const lines: string[] = [];
  lines.push("");
  lines.push(`offmute-v2 lifetime stats  (${statsDir()})`);
  lines.push("");
  lines.push(`  runs            ${s.runs}`);
  lines.push(`  media processed ${formatDuration(Math.round(s.mediaSeconds))}  (${(s.mediaSeconds / 3600).toFixed(1)}h)`);
  lines.push(`  characters out  ${s.characters.toLocaleString()}`);
  lines.push(`  LLM calls       ${s.llmCalls.toLocaleString()}  (${(s.inputTokens / 1e6).toFixed(1)}M in / ${(s.outputTokens / 1e6).toFixed(1)}M out)`);
  lines.push(`  total cost      ~$${s.costUsd.toFixed(2)}`);
  if (s.firstRun) lines.push(`  since           ${s.firstRun.slice(0, 10)}`);
  const models = Object.entries(s.costByModel).sort((a, b) => b[1] - a[1]);
  if (models.length) {
    lines.push("");
    lines.push("  cost by model");
    for (const [model, usd] of models) {
      const runs = s.runsByModel[model] ? ` · ${s.runsByModel[model]} runs` : "";
      lines.push(`    ${model.padEnd(28)} ~$${usd.toFixed(2)}${runs}`);
    }
  }
  lines.push("");
  console.log(lines.join("\n"));
}
