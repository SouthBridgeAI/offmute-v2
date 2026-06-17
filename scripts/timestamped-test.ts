/**
 * Test H2: transcribe the whole file with AssemblyAI (word timestamps + diarization).
 * Usage: npx tsx scripts/timestamped-test.ts [audioPath]
 * Default audioPath = ./intermediates/preprocess-test/audio.flac
 */
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { AssemblyAIProvider } from "../src/providers/assemblyai.js";
import { secondsToTimestamp } from "../src/utils/time.js";

async function main() {
  const audio = resolve(process.argv[2] || "./intermediates/preprocess-test/audio.flac");
  const outDir = resolve("./intermediates/timestamped-test");
  const provider = new AssemblyAIProvider({
    apiKey: process.env.ASSEMBLYAI_API_KEY!,
    cacheDir: outDir,
  });

  const t0 = Date.now();
  const result = await provider.transcribe(audio);
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`speech model used: ${result.speechModelUsed}`);
  console.log(`duration: ${result.durationSec.toFixed(1)}s (audio: ${result.audioDurationSec?.toFixed(1)}s)`);
  console.log(`utterances: ${result.utterances.length}, words: ${result.words.length}`);
  console.log(`speakers: ${result.speakers.join(", ")}`);

  console.log("\n=== FIRST 8 UTTERANCES ===");
  for (const u of result.utterances.slice(0, 8)) {
    console.log(
      `[${secondsToTimestamp(u.start)} → ${secondsToTimestamp(u.end)}] ${u.speaker} (conf ${(u.confidence ?? 0).toFixed(2)}): ${u.text.slice(0, 90)}`,
    );
  }

  // Speaker talk-time breakdown.
  const talk: Record<string, number> = {};
  for (const u of result.utterances) talk[u.speaker] = (talk[u.speaker] || 0) + (u.end - u.start);
  console.log("\n=== TALK TIME ===");
  for (const [sp, sec] of Object.entries(talk)) {
    console.log(`  ${sp}: ${sec.toFixed(0)}s (${((sec / result.durationSec) * 100).toFixed(0)}%)`);
  }

  writeFileSync(`${outDir}/timestamped.json`, JSON.stringify(result, null, 2));
  console.log(`\nsaved ${outDir}/timestamped.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
