/**
 * Eval: score a pipeline output (JSON) against the hand-checked reference SRT.
 * Usage: npx tsx scripts/eval.ts [outputJson] [referenceSrt]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseReferenceSrt, score, printScore } from "../src/eval/scorer.js";
import type { TranscriptResult } from "../src/core/types.js";

async function main() {
  const outPath = resolve(process.argv[2] || "./output/run1/talk-with-questions.json");
  const refPath = resolve(process.argv[3] || "../test-files/1/talk-with-questions.srt");
  const result = JSON.parse(readFileSync(outPath, "utf-8")) as TranscriptResult;
  const ref = parseReferenceSrt(refPath);
  console.log(`output: ${outPath} (${result.segments.length} segments)`);
  console.log(`reference: ${refPath} (${ref.length} entries)`);
  const s = score(result.segments, ref);
  printScore(s);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
