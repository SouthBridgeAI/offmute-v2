# offmute-v2

Best-in-class diarized meeting transcription. A video/audio file (plus optional
instructions) goes in; a **timestamp-correct, diarized transcript with tone/behavior
labels** comes out — as SRT, Markdown, and JSON.

Runs as an **npx CLI**, a **Node library**, and **in the browser**.

> Living context: `intermediates/process_log_thoughts_ideas_hypotheses_and_scratch_space.md`
> (hypotheses, findings, gotchas) and `docs/spec.md` (design). Re-read when context compresses.

## Results (verified on test-files/1: 32min talk + audience Q&A)

End-to-end pipeline vs the hand-checked reference SRT (38 entries):

| metric | result |
|---|---|
| word accuracy (WER) | **86.5%** (WER 0.135) |
| reference coverage | **38/38** entries covered |
| boundary timing | **median 0.00s, p90 2.16s** |
| speaker accuracy | **94%** |
| alignment | 326/326 segments aligned to ASR word timing |

Speaker diarization correctly separates the presenter (named **Rishi** via the
identification pass) from 3 audience questioners, merging an AssemblyAI over-split of
the presenter into two speakers.

## How it works

A **hybrid** of two complementary strengths (the `inspirations/` projects each had one):

- **Multimodal LLM** (Gemini) → best *content*: verbatim text, tone, diarization through
  interruptions, speaker identification via context. Coarse timestamps only.
- **Timestamped transcriber** (AssemblyAI Universal-2) → best *timing*: word-accurate
  timestamps + clean speaker separation over the whole file. No tone/context.

```
preprocess → describe → llm-transcribe (per chunk) → timestamped (whole file)
                                                              ↓
                            align (edit-distance: LLM text ↔ ASR word times)
                                                              ↓
                            gap-fill (recover dropped content from ASR)
                                                              ↓
                            consistency (merge ASR over-splits via LLM labels)
                                                              ↓
                            identify (optional, DeepSeek: name speakers from content)
                                                              ↓
                            finalize (dedup, overlap fix, clamp, format SRT/MD/JSON)
```

**The alignment** is the key idea (ts-aligner approach): align the whole chunk's LLM
token stream against the ASR word stream in one edit-distance DP pass, then split back
into segments — long ordered sequences pin common words unambiguously and transfer
accurate word timestamps onto the richer LLM text.

**Gap-fill** recovers content the LLM dropped: where ASR has speech in a time gap not
covered by any LLM segment (e.g. a dropped opening word), an ASR fallback segment is
inserted — so nothing the ASR heard is lost.

**Timestamped providers**: AssemblyAI Universal-2 (default — diarization + word
timestamps) or Groq Whisper (`--timestamped whisper-groq` — free/fast word timestamps,
no diarization; consistency then groups by LLM label).

## Diarization levels (selectable via `--level`)

1. **Separation** — who speaks when (ASR speakers).
2. **Anonymous-but-consistent** — Speaker A/B throughout (ASR speakers merged by LLM label; default).
3. **Identification** — named speakers via content cues (DeepSeek).

## Usage

### npx CLI
```bash
export GEMINI_API_KEY=...         # multimodal transcription
export ASSEMBLYAI_API_KEY=...     # timestamped transcription
export DEEPSEEK_API_KEY=...       # optional, for --level 3 identification

npx offmute-v2 meeting.mov                          # default: flash model, level 2
npx offmute-v2 meeting.mov --model gemini-2.5-pro   # higher quality
npx offmute-v2 meeting.mov --level 3                # name speakers
npx offmute-v2 meeting.mov -i "focus on action items, note accents"
npx offmute-v2 meeting.mov --passes align,consistency,finalize   # resume from intermediates
npx offmute-v2 meeting.mov --only-chunk 2           # debug one chunk
```

Key options: `--passes`, `--level <1|2|3>`, `--model`, `--timestamped assemblyai|whisper-groq`,
`--formats srt,md,json`, `--chunk-seconds`, `--overlap-seconds`, `--concurrency`,
`--instructions`, `--force`, `--only-chunk`, `--reasoner`.

### Node library
```ts
import { transcribe } from "offmute-v2";
const result = await transcribe("meeting.mov", {
  model: "gemini-2.5-flash",
  level: 3,
  instructions: "...",
  apiKeys: { gemini: "...", assemblyai: "...", deepseek: "..." }, // injectable
  formats: ["srt", "md", "json"],
});
// result.segments: Segment[], result.speakers: SpeakerInfo[]
```

### Browser
```ts
import { transcribeBrowser } from "offmute-v2/browser";
// audio = mono Blob (extract from video via ffmpeg.wasm first)
const result = await transcribeBrowser({
  audio, geminiApiKey, assemblyaiApiKey,
  model: "gemini-2.5-flash", level: 3, deepseekApiKey,
});
```
The core (align/consistency/identify/finalize/format) is pure TS with no node deps and
bundles to ~35KB with zero node-only imports. The browser build uses fetch-based
providers (Gemini inline base64 + AssemblyAI REST). Best for audio ≤ ~20MB inline; for
longer files, chunk with ffmpeg.wasm and call the stages directly.

## Architecture

```
src/
  core/      types, config (models, key resolution, chunk planning), pipeline
  audio/     ffmpeg wrapper (probe, audio, chunk, scene-aware keyframes, silence)
  providers/ gemini (SDK), gemini-fetch + assemblyai-fetch (browser), openai-compat (DeepSeek/Groq)
  transcribe/ llm transcription (prompt + JSON schema), describe (roster)
  align/     normalize, edit-distance DP, aligner (flat-sequence alignment)
  diarize/   consistency (merge by LLM label), identify (DeepSeek naming)
  finalize/  dedup, overlap fix + clamp, format (SRT/MD/JSON with block-breaking)
  eval/      scorer (WER, coverage, timing, speaker agreement vs reference)
  utils/     time, srt, logger
scripts/     per-stage test scripts + eval
tests/       vitest unit tests (align, finalize)
```

Every pipeline stage persists intermediates to disk and is **resumable** (skips work
whose output exists unless `--force`); the run is **stoppable** — results so far are
always on disk.

## Development
```bash
npm install
npm run typecheck && npm run lint && npm test   # 16 unit tests
npm run dev    # tsx src/cli.ts
npm run build  # tsup → dist/ (node + browser bundles)
```

## Requirements
- Node ≥ 20, ffmpeg/ffprobe in PATH.
- API keys: `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), `ASSEMBLYAI_API_KEY`. `DEEPSEEK_API_KEY` optional (level 3). `GROQ_API_KEY` optional (whisper-groq fallback).

## Eval
```bash
npx tsx scripts/eval.ts output/run1/talk-with-questions.json   # vs test-files/1 reference SRT
```

## License
Apache-2.0.
