/**
 * Exploratory: Gemini diarized transcription on a clip.
 * Run: bun run scripts/test-gemini-diarize.ts [clip] [model]
 *   clip default: talk-clip-0-180 ; model default: gemini-flash-latest
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GeminiClient } from "../src/providers/gemini.js";

const clip = process.argv[2] ?? "talk-clip-0-180";
const model = process.argv[3] ?? "gemini-flash-latest";
const thinkingBudget = process.argv[4] !== undefined ? Number(process.argv[4]) : 4096;
const audio = join(import.meta.dir, `../../intermediates/media/${clip}.mp3`);
const outDir = join(import.meta.dir, "../../intermediates/gemini");
mkdirSync(outDir, { recursive: true });

const PROMPT = `This is an audio clip from a recorded talk/meeting.

Transcribe it as a diarized transcript:
- Diarize: identify each distinct speaker. Use real names if you can infer them from what's said; otherwise label "Speaker 1", "Speaker 2", etc. Keep labels consistent.
- For EACH speaker turn, give the start timestamp in [mm:ss].
- Add a brief tone/emotion note in parentheses when notable, e.g. (hesitant), (laughing), (audience member, from the back), (emphatic).
- Transcribe verbatim, including filler and false starts.

Output one line per speaker turn, exactly:
[mm:ss] Speaker: (tone) text

Begin.`;

const client = new GeminiClient();
console.log(`Gemini ${model} diarizing ${clip}.mp3 ...`);
const t0 = performance.now();
const res = await client.generate([{ filePath: audio }, { text: PROMPT }], {
  model,
  temperature: 0.2,
  maxOutputTokens: 65536,
  thinkingBudget,
});
const secs = ((performance.now() - t0) / 1000).toFixed(1);
console.log(`Done in ${secs}s  tokens: in=${res.usage?.inputTokens} out=${res.usage?.outputTokens} thoughts=${res.usage?.thoughtsTokens}`);

const stem = `${clip}.${model}`;
writeFileSync(join(outDir, `${stem}.txt`), res.text);
console.log("\n===== OUTPUT =====\n");
console.log(res.text);
