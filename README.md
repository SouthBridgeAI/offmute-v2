# offmute-v2

Best-in-class diarized meeting transcription. A video/audio file (plus optional
instructions) goes in; a **timestamp-correct, diarized transcript with tone/behavior
labels** comes out — as SRT, Markdown, and JSON.

> **Status: scaffolding + research phase.** See
> `intermediates/process_log_thoughts_ideas_hypotheses_and_scratch_space.md` for the
> living record of hypotheses, findings, and gotchas. Re-read both when context
> compresses.

## The idea

Combine two complementary strengths (the three `inspirations/` projects each had
only one):

- **Multimodal LLMs** (Gemini, GPT-4o-audio) understand tone, mix video+audio
  context, diarize through interruptions, and listen in crowded rooms — but their
  timestamps are coarse. *(offmute does this, but can't do SRTs/timestamps.)*
- **Timestamped transcribers** (AssemblyAI, Whisper) give accurate word-level
  timestamps and clean speaker separation — but no tone, no context, no
  identification. *(meeting-diary does this.)*

`ipgu` contributed the timestamp mechanics (relative→absolute adjustment, overlap
resolution, XML structured output, robust parsing, retries). offmute-v2 unifies all
of it and fixes the shared weakness: **chunking and overlap handling**.

## Pipeline (target)

```
preprocess ──▶ describe ──▶ LLM-transcribe (per chunk, diarized, tone, rel. ts)
   (audio+          │              │
   keyframes)       │              ▼
                    │      ┌─── timestamped-transcribe (AssemblyAI/Whisper, whole file)
                    │      │              │
                    │      │              ▼
                    └──────┴─────▶ align (fuzzy/embedding: LLM text ↔ accurate ts)
                                          │
                                          ▼
                          speaker-consistency ──▶ speaker-identify (optional)
                                          │
                                          ▼
                              finalize (overlap fix, clamp, format SRT/MD/JSON)
```

Every stage writes intermediates to disk and is resumable.

## Diarization levels (selectable)

1. **Separation** — who speaks when.
2. **Anonymous-but-consistent** — Speaker A/B throughout.
3. **Identification** — named speakers via context (multi-pass).

## Model assignment

- Multimodal transcription (needs ears): **Gemini 2.5 Pro/Flash** primary.
- Timestamped transcription: **AssemblyAI** primary; Whisper (Groq/OpenAI) fallback.
- Text reasoning passes (ID, consistency, refinement): **DeepSeek** (cheap reasoner).
- DeepSeek cannot hear audio — text passes only.

Keys come from the environment (or are injected). See `src/core/config.ts`.

## Usage (once built)

```bash
# CLI
npx offmute-v2 path/to/meeting.mov --model gemini-2.5-pro --instructions "..."
npx offmute-v2 meeting.mov --passes transcribe,align,identify --format srt,md

# Library
import { transcribe } from "offmute-v2";
const result = await transcribe("meeting.mov", { /* options */ });
```

## Project layout

```
src/
  core/      types, config, pipeline orchestrator
  audio/     ffmpeg wrapper, chunking (silence-aware overlap dedup)
  providers/ gemini, deepseek, assemblyai, whisper (+ OpenAI-compat)
  transcribe/ llm transcription + prompts + structured-output parser
  align/     fuzzy/embedding alignment of LLM text ↔ timestamps
  diarize/   speaker-consistency + identification passes
  finalize/  overlap resolution, timing clamp, SRT/MD/JSON formatting
  utils/     fs, time, srt, logger
scripts/     one-off test scripts per pipeline part
tests/       unit tests (vitest)
```

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run lint
npm test            # vitest
npm run dev         # tsx src/cli.ts
npm run build       # tsup → dist/
```

## Testing & eval

Ground truth: `test-files/1/talk-with-questions.mov` + `.srt` (Hrishi + Audience,
~32min). An eval scorer (text WER, timing error, speaker-label accuracy) compares
output ↔ reference so we know when a pass fails. `test-files/2` (Satya Nadella
podcast, ~41min, no ref) for multi-speaker smoke tests.

## License

Apache-2.0.
