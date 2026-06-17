/**
 * Test H1: transcribe one audio chunk with Gemini, validate parsing + span.
 * Usage: npx tsx scripts/llm-transcribe-test.ts [model] [startSec] [durationSec]
 * Defaults: gemini-2.5-flash, 0, 300
 */
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { GeminiClient } from "../src/providers/gemini.js";
import { transcribeChunk } from "../src/transcribe/llm-transcribe.js";
import { extractChunk } from "../src/audio/ffmpeg.js";
import { secondsToTimestamp } from "../src/utils/time.js";

async function main() {
  const model = process.argv[2] || "gemini-2.5-flash";
  const startSec = parseFloat(process.argv[3] || "0");
  const durationSec = parseFloat(process.argv[4] || "300");
  const outDir = resolve("./intermediates/llm-test");

  const masterAudio = resolve("./intermediates/preprocess-test/audio.flac");
  const chunkPath = `${outDir}/chunk_000.flac`;
  logger_info(`Extracting chunk [${startSec}-${startSec + durationSec}]s...`);
  await extractChunk(masterAudio, chunkPath, startSec, startSec + durationSec, {
    format: "flac",
  });

  const client = new GeminiClient(process.env.GEMINI_API_KEY!);
  logger_info(`Transcribing with ${model}...`);
  const result = await transcribeChunk(
    client,
    model,
    chunkPath,
    startSec,
    {
      index: 1,
      total: 1,
      description:
        "A recorded tech talk. A main presenter speaks to an audience; audience members interject with questions and comments.",
      roster: "Presenter (main speaker), Audience (question askers)",
    },
    { chunkDurationSec: durationSec, validationRetries: 1 },
  );

  console.log("\n=== VALIDATION ===");
  console.log(result.validation);
  console.log("usage:", result.usage);
  if (result.error) console.log("error:", result.error);

  console.log("\n=== SEGMENTS ===");
  for (const s of result.segments) {
    const tone = s.tone.length ? ` (${s.tone.join(",")})` : "";
    console.log(
      `[${secondsToTimestamp(s.startSec)} → ${secondsToTimestamp(s.endSec)}] ${s.speaker}${tone}: ${s.text.slice(0, 120)}${s.text.length > 120 ? "…" : ""}`,
    );
  }

  writeFileSync(`${outDir}/chunk_000_raw.json`, result.raw);
  writeFileSync(
    `${outDir}/chunk_000_parsed.json`,
    JSON.stringify(result, null, 2),
  );
  logger_info(`saved to ${outDir}/`);
}

function logger_info(msg: string) {
  console.log(`[info] ${msg}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
