/**
 * Preprocess the primary test file: probe, extract full 16k-mono audio,
 * make short clips for fast iteration, grab keyframes. Writes to ../intermediates/media.
 *
 * Run: bun run scripts/preprocess-test.ts
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { extractAudio, extractKeyframes, probeMedia } from "../src/media/ffmpeg.js";

const TEST_MOV = join(import.meta.dir, "../../test-files/1/talk-with-questions.mov");
const OUT = join(import.meta.dir, "../../intermediates/media");

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const r = await fn();
  console.log(`  ${label}: ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  return r;
}

const info = await probeMedia(TEST_MOV);
console.log("Media info:", JSON.stringify(info, null, 2));

console.log("\nExtracting full audio (16k mono mp3)...");
const fullMp3 = join(OUT, "talk-full.mp3");
await timed("full audio", () => extractAudio(TEST_MOV, fullMp3, { sampleRate: 16000, channels: 1 }));
console.log(`  -> ${fullMp3} (${mb(statSync(fullMp3).size)})`);

// Clips for fast iteration (cover ground-truth regions)
const clips: Array<{ name: string; start: number; dur: number; note: string }> = [
  { name: "clip-0-180", start: 0, dur: 180, note: "intro, cues 1-7 start (Hrishi + Audience interjections)" },
  { name: "clip-720-960", start: 720, dur: 240, note: "end of monologue + first Q&A (cues 7-10)" },
];
console.log("\nExtracting clips...");
for (const c of clips) {
  const p = join(OUT, `talk-${c.name}.mp3`);
  await timed(c.name, () =>
    extractAudio(TEST_MOV, p, { sampleRate: 16000, channels: 1, startSeconds: c.start, durationSeconds: c.dur })
  );
  console.log(`  -> ${p} (${mb(statSync(p).size)}) — ${c.note}`);
}

// Also a stereo version of the first clip (test L/R diarization hint later)
const stereoClip = join(OUT, "talk-clip-0-180-stereo.mp3");
await timed("clip-0-180 stereo", () =>
  extractAudio(TEST_MOV, stereoClip, { sampleRate: 16000, channels: 2, startSeconds: 0, durationSeconds: 180 })
);
console.log(`  -> ${stereoClip} (${mb(statSync(stereoClip).size)})`);

console.log("\nExtracting keyframes (8 across full)...");
const frames = await timed("keyframes", () =>
  extractKeyframes(TEST_MOV, join(OUT, "keyframes"), { count: 8, durationSeconds: info.durationSeconds, maxSize: 768 })
);
for (const f of frames) console.log(`  -> ${f} (${mb(statSync(f).size)})`);

console.log("\nDone.");
