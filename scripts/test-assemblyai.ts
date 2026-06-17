/**
 * Test AssemblyAI on a clip. Saves raw + normalized JSON to ../intermediates/asr.
 * Run: bun run scripts/test-assemblyai.ts [clipName]   (default: talk-clip-0-180)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transcribeWithAssemblyAI } from "../src/providers/assemblyai.js";
import { secondsToCompact } from "../src/core/time.js";

const clip = process.argv[2] ?? "talk-clip-0-180";
const audio = join(import.meta.dir, `../../intermediates/media/${clip}.mp3`);
const outDir = join(import.meta.dir, "../../intermediates/asr");
mkdirSync(outDir, { recursive: true });

console.log(`AssemblyAI transcribing ${clip}.mp3 ...`);
const t0 = performance.now();
const { asr, raw } = await transcribeWithAssemblyAI(audio, { speakerLabels: true });
console.log(`Done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

writeFileSync(join(outDir, `${clip}.raw.json`), JSON.stringify(raw, null, 2));
writeFileSync(join(outDir, `${clip}.asr.json`), JSON.stringify(asr, null, 2));

console.log(`\nprovider=${asr.provider} diarized=${asr.diarized} lang=${asr.language}`);
console.log(`duration=${asr.durationSeconds}s  words=${asr.words.length}  utterances=${asr.utterances.length}`);
console.log(`speakers=[${asr.speakers.join(", ")}]`);

console.log(`\n--- Utterances ---`);
for (const u of asr.utterances) {
  const text = u.text.length > 110 ? u.text.slice(0, 110) + "…" : u.text;
  console.log(`[${secondsToCompact(u.start)}-${secondsToCompact(u.end)}] ${u.speaker}: ${text}`);
}

console.log(`\n--- First 12 words with timing ---`);
for (const w of asr.words.slice(0, 12)) {
  console.log(`  ${w.start.toFixed(2)}-${w.end.toFixed(2)} [${w.speaker ?? "?"}] ${w.text}`);
}
