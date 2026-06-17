/**
 * Basic offmute-v2 usage. Run with: bun run examples/basic.ts <media-file>
 * Requires GEMINI_API_KEY and ASSEMBLYAI_API_KEY in the environment.
 */
import { transcribe, toMarkdown } from "../src/index.js";

const input = process.argv[2];
if (!input) {
  console.error("usage: bun run examples/basic.ts <audio-or-video-file>");
  process.exit(1);
}

const { transcript, srt } = await transcribe(input, {
  // Optional: steer speaker labelling. Omit to let it auto-identify.
  instructions: "Label speakers by name where possible.",
  onProgress: (e) => console.error(`[${e.stage}] ${e.message}`),
});

console.log(`\nSpeakers: ${transcript.speakers.map((s) => s.label).join(", ")}`);
console.log(`Segments: ${transcript.segments.length}\n`);

// First few segments
for (const seg of transcript.segments.slice(0, 5)) {
  const speaker = transcript.speakers.find((s) => s.id === seg.speakerId);
  console.log(`[${seg.start.toFixed(1)}s] ${speaker?.label}: ${seg.text}`);
}

// `srt` / `toMarkdown(transcript)` give ready-to-write outputs.
void toMarkdown;
void srt;
