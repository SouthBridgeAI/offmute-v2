# offmute-v2 🎙️⏱️

**Timestamp-correct, diarized meeting transcription.** Point it at a video or audio file and get back a transcript where every speaker turn is on the right millisecond, labelled with the speaker's name (when it can be inferred) and tone — as **SRT**, **Markdown**, or **JSON**.

It's the successor to [offmute](https://github.com/southbridgeai/offmute): great diarized transcripts, but now with real timestamps.

```bash
export GEMINI_API_KEY=...        # multimodal understanding
export ASSEMBLYAI_API_KEY=...    # word-level timing
npx offmute-v2 meeting.mp4 -i "Two founders chatting; label them by name."
# → meeting.srt  meeting.md  meeting.json
```

## Why it's accurate

No single model is good at everything, so offmute-v2 uses each for what it's best at and **fuses** them:

| Job | Tool | Why |
|-----|------|-----|
| **WHEN** — word-level timestamps | ASR (AssemblyAI) | sub-second accurate; LLM timestamps drift minutes over a long file |
| **WHO / HOW** — names, tone, hard audio | multimodal LLM (Gemini) | infers names from context, hears tone, handles crowds/interruptions; raw ASR diarization can't |
| **fuse** | token alignment | maps the LLM's words onto the ASR's timestamps |

The LLM writes the transcript and decides who's talking; the ASR supplies the clock; an alignment pass marries them. (Details in [`docs/SPEC.md`](docs/SPEC.md).)

### Measured on a 32-minute talk (founder presentation + audience Q&A)

Against a hand-checked reference transcript:

- **Word error rate: 8.1%**
- **Speaker attribution: 98.8%** (word-level)
- **Turn-boundary timing: 0.04s median, 0.43s p90** error

In a few places it diarizes *better* than the hand-checked reference (e.g. splitting an audience question from the speaker's answer where the reference merged them).

## CLI

```bash
npx offmute-v2 <input> [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `-i, --instructions <text>` | – | guide speaker labelling/focus, e.g. "host is Alice; group callers as 'Caller'" |
| `-m, --model <model>` | `gemini-flash-latest` | LLM (e.g. `gemini-pro-latest` for max quality) |
| `--asr <provider>` | `assemblyai` | `assemblyai` or `none` (LLM-only timing, less precise) |
| `--no-video` | – | ignore the video track (audio only) |
| `--keyframes <n>` | `8` | video frames sampled for visual context |
| `--no-sub-segment` | – | keep whole speaker turns instead of subtitle-sized cues |
| `--no-identify` | – | skip the speaker name-resolution pass |
| `--thinking-level <lvl>` | `MINIMAL` | `MINIMAL\|LOW\|MEDIUM\|HIGH` (MINIMAL is best for transcription) |
| `-o, --out <dir>` | `.` | where to write outputs |
| `-f, --format <fmt>` | `all` | `srt \| md \| json \| all` |
| `--intermediates-dir <dir>` | `.offmute_<name>` | cache dir (resumable) |
| `--no-cache` | – | ignore cached intermediates |

Intermediates (extracted audio, ASR JSON, raw LLM output, keyframes) are saved and reused, so re-runs are cheap and interrupted runs resume.

## Library

```ts
import { transcribe, toSRT, toMarkdown } from "offmute-v2";

const { transcript, srt, markdown } = await transcribe("meeting.mp4", {
  instructions: "Panel of three; label by name.",
  llmModel: "gemini-flash-latest",
  onProgress: (e) => console.log(e.stage, e.message),
});

console.log(transcript.speakers);          // [{ id, label, named, description }]
console.log(transcript.segments[0]);       // { start, end, speakerId, text, tone, ... }
```

Long files (>35 min) are automatically chunked with overlap and stitched back together; the whole-file ASR voice clusters keep speaker identity consistent across chunks.

## Browser

The fusion core is pure and dependency-free (`offmute-v2/browser`, ~32KB). The host handles media (ffmpeg.wasm) and provider calls (fetch), then fuses:

```ts
import { parseDiarizedText, assembleTranscript, toSRT } from "offmute-v2/browser";

const asr = await myAsr(audioBlob);                  // -> AsrResult (words + times)
const turns = parseDiarizedText(await myLLM(audioBlob, prompt));
const { transcript } = assembleTranscript({ turns, asr, durationSeconds: asr.durationSeconds });
const srt = toSRT(transcript);
```

## Requirements

- Node ≥ 18 and `ffmpeg`/`ffprobe` on PATH (CLI / Node library).
- API keys from env or injected (`apiKeys` option): `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), `ASSEMBLYAI_API_KEY`.

## Diarization levels

1. **Separation** — who speaks when. 2. **Anonymous-consistent** — Speaker A/B, stable throughout. 3. **Identification** — real names from context. offmute-v2 targets **3**, with instruction-driven grouping (e.g. "everyone except the host is 'Audience'").

## Credits

Builds on three predecessors: **offmute** (multimodal describe→transcribe, tone), **ipgu** (chunk/merge discipline, timestamp validation), **meeting-diary** (ASR word-timestamps + diarization). Created by [Southbridge](https://southbridge.ai).

License: Apache-2.0.
