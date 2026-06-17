# Running offmute-v2 in the browser

The **fusion core** — alignment, segmentation, speaker building, formatting, the
diarization prompt, the ASR-voice-anchored identify logic — is pure TypeScript
with zero Node/SDK dependencies. It's published as `offmute-v2/browser` (~32 KB)
and runs anywhere.

The browser host supplies the two environment-specific steps:

1. **Decode/downsample media → 16 kHz mono audio** (via `@ffmpeg/ffmpeg`, WASM).
2. **Call the providers** (ASR for word timing, the LLM for diarization) over
   `fetch`.

Then it feeds the results into the core. Here's the whole flow.

## 1. Preprocess with ffmpeg.wasm

```ts
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";

const ffmpeg = new FFmpeg();
await ffmpeg.load();
await ffmpeg.writeFile("in", await fetchFile(file)); // file: a File/Blob
await ffmpeg.exec(["-i", "in", "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", "out.mp3"]);
const audio = new Blob([await ffmpeg.readFile("out.mp3")], { type: "audio/mp3" });
```

(Keyframes for visual context: `-ss <t> -frames:v 1 frame.jpg`, same as the Node path.)

## 2. ASR — word-level timing (AssemblyAI over fetch)

```ts
// upload
const up = await fetch("https://api.assemblyai.com/v2/upload", {
  method: "POST", headers: { authorization: ASSEMBLYAI_KEY }, body: audio,
}).then((r) => r.json());
// request
let t = await fetch("https://api.assemblyai.com/v2/transcript", {
  method: "POST",
  headers: { authorization: ASSEMBLYAI_KEY, "content-type": "application/json" },
  body: JSON.stringify({ audio_url: up.upload_url, speaker_labels: true }),
}).then((r) => r.json());
// poll t.id until status === "completed", then map to AsrResult:
import type { AsrResult } from "offmute-v2/browser";
const asr: AsrResult = {
  provider: "assemblyai",
  words: t.words.map((w) => ({ text: w.text, start: w.start / 1000, end: w.end / 1000, speaker: w.speaker, confidence: w.confidence })),
  utterances: (t.utterances ?? []).map((u) => ({ text: u.text, start: u.start / 1000, end: u.end / 1000, speaker: u.speaker })),
  speakers: [...new Set((t.words ?? []).map((w) => w.speaker).filter(Boolean))],
  durationSeconds: t.audio_duration,
  language: t.language_code,
  diarized: (t.utterances ?? []).length > 0,
};
```

## 3. Diarize — the LLM (Gemini over fetch)

Build the prompt with the core helper, then call the REST API. For long audio use
the [Files API](https://ai.google.dev/api/files); for short clips, inline base64.

```ts
import { buildDiarizationPrompt, buildAsrHint } from "offmute-v2/browser";

const prompt = buildDiarizationPrompt({ instructions, asrHint: buildAsrHint(asr) });
const res = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_KEY}`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ fileData: { fileUri, mimeType: "audio/mp3" } }, { text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 65536, thinkingConfig: { thinkingLevel: "MINIMAL" } },
    }),
  }
).then((r) => r.json());
const diarizedText = res.candidates[0].content.parts.map((p) => p.text).join("");
```

> **Important:** use `thinkingLevel: "MINIMAL"`. On long audio, higher thinking
> consumes the entire output budget and returns empty (see the process log).

## 4. Fuse

```ts
import { parseDiarizedText, assembleTranscript, toSRT, toMarkdown } from "offmute-v2/browser";

const turns = parseDiarizedText(diarizedText);
const { transcript } = assembleTranscript({ turns, asr, durationSeconds: asr.durationSeconds });

const srt = toSRT(transcript);
const md = toMarkdown(transcript);
```

For the speaker name-resolution pass, call `identifySpeakersLLM(generator, turns, …)`
with a tiny `generator` that wraps your `fetch` LLM call (it's text-only), then pass
the resulting `aliases`/`descriptions` to `buildTranscript`.

## Notes

- Keys are injected by the host; never hard-code them in shipped JS.
- Chunking for very long files: use `calculateChunks(...)` from the core, run the
  ffmpeg `-ss/-t` slice per chunk, align each to the windowed ASR words, and merge
  with `mergeChunkSegments(...)` — exactly what the Node pipeline does.
