/**
 * Verify the isomorphic fetch providers work (run in Node, but they use the same
 * `fetch` the browser would). Tests AssemblyAI + Gemini on the intro clip.
 * Run: bun run scripts/test-fetch-providers.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transcribeWithAssemblyAIFetch } from "../src/providers/assemblyai-fetch.js";
import { GeminiFetchClient } from "../src/providers/gemini-fetch.js";

const clip = join(import.meta.dir, "../../intermediates/media/talk-clip-0-180.mp3");
const bytes = new Uint8Array(readFileSync(clip));
console.log(`clip: ${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB`);

console.log("\n[1] AssemblyAI (fetch)…");
let t0 = performance.now();
const { asr } = await transcribeWithAssemblyAIFetch(bytes, { speakerLabels: true });
console.log(`  ${((performance.now() - t0) / 1000).toFixed(1)}s — words=${asr.words.length} utterances=${asr.utterances.length} speakers=[${asr.speakers.join(",")}] dur=${asr.durationSeconds}s`);
console.log(`  first words: ${asr.words.slice(0, 6).map((w) => `${w.text}@${w.start.toFixed(2)}`).join(" ")}`);

console.log("\n[2] Gemini (fetch, Files API upload + generateContent)…");
t0 = performance.now();
const gem = new GeminiFetchClient();
const res = await gem.generate(
  [
    { data: { bytes, mimeType: "audio/mp3", displayName: "clip" } },
    { text: "Diarize and transcribe. Format each line: [mm:ss] Speaker: text" },
  ],
  { model: "gemini-flash-latest", thinkingLevel: "MINIMAL", maxOutputTokens: 8192 }
);
console.log(`  ${((performance.now() - t0) / 1000).toFixed(1)}s — textLen=${res.text.length} in=${res.usage?.inputTokens} out=${res.usage?.outputTokens}`);
console.log("  head:\n" + res.text.split("\n").slice(0, 4).map((l) => "    " + l).join("\n"));

console.log("\n✓ both fetch providers work");
