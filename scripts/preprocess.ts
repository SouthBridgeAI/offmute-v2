/**
 * Test script: preprocess a media file (probe + audio + silence + keyframes).
 * Usage: npx tsx scripts/preprocess.ts <input> [outDir]
 */
import { resolve } from "node:path";
import {
  checkFfmpeg,
  probe,
  extractAudio,
  detectSilence,
  extractKeyframes,
} from "../src/audio/ffmpeg.js";
import { planChunks } from "../src/core/config.js";
import { snapToSilence } from "../src/audio/ffmpeg.js";
import { writeFileSync } from "node:fs";
import { logger } from "../src/utils/logger.js";

async function main() {
  const input = process.argv[2];
  const outDir = resolve(process.argv[3] || "./intermediates/preprocess-test");
  if (!input) {
    console.error("Usage: npx tsx scripts/preprocess.ts <input> [outDir]");
    process.exit(1);
  }
  logger.setLevel("debug");

  if (!(await checkFfmpeg())) {
    console.error("ffmpeg/ffprobe not found");
    process.exit(1);
  }

  logger.info(`Probing ${input}...`);
  const info = await probe(input);
  console.log("PROBE:", JSON.stringify(info, null, 2));

  logger.info("Extracting audio (mono 16kHz FLAC)...");
  const audioPath = `${outDir}/audio.flac`;
  const t0 = Date.now();
  await extractAudio(input, audioPath, { format: "flac" });
  const { sizeBytes } = await probe(audioPath);
  logger.info(
    `audio done in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${audioPath} (${((sizeBytes || 0) / 1e6).toFixed(1)}MB)`,
  );

  logger.info("Detecting silence...");
  const silences = await detectSilence(audioPath, { noiseDb: -30, minDuration: 0.3 });
  logger.info(`found ${silences.length} silent ranges (first 5):`);
  for (const s of silences.slice(0, 5)) {
    console.log(`  ${s.start.toFixed(2)} - ${s.end.toFixed(2)} (${s.duration.toFixed(2)}s)`);
  }

  if (info.hasVideo) {
    logger.info("Extracting keyframes (scene-aware)...");
    const t1 = Date.now();
    const kfs = await extractKeyframes(input, `${outDir}/keyframes`, 6);
    logger.info(`keyframes done in ${((Date.now() - t1) / 1000).toFixed(1)}s:`);
    for (const k of kfs) console.log(`  ${k.time.toFixed(2)}s  ${k.path}`);
  }

  // Demonstrate silence-aware chunking on the master audio.
  logger.info("Planning + snapping chunks...");
  const chunks = planChunks(info.duration, 600, 60);
  console.log(`planned ${chunks.length} chunks; snapping boundaries to silence:`);
  for (const c of chunks.slice(0, 4)) {
    const snapped = snapToSilence(c.start, silences, 5);
    console.log(
      `  chunk ${c.index}: ${c.start.toFixed(1)}-${c.end.toFixed(1)} (overlap ${c.overlapWithPrevious}s, trusted ${c.trustedStart.toFixed(1)}) → snapped start ${snapped.toFixed(1)}`,
    );
  }

  writeFileSync(
    `${outDir}/probe.json`,
    JSON.stringify({ info, silences, chunkCount: chunks.length }, null, 2),
  );
  logger.info(`wrote ${outDir}/probe.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
