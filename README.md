# offmute-v2 🎙️⏱️

**Timestamp-correct, diarized meeting transcription** — combining multimodal LLMs (who's talking, tone, names, fixing hard audio) with ASR timing tracks (accurate word-level timestamps). The successor to [offmute](https://github.com/southbridgeai/offmute), which produces great diarized transcripts but no timestamps.

> Status: **early development**. See `../intermediates/process_log_thoughts_ideas_hypotheses_and_scratch_space.md` for the running design log and `docs/SPEC.md` (once written) for the plan.

## The idea

Each tool is best at one thing:

| Axis | Best tool |
|------|-----------|
| **WHEN** — accurate word/utterance timestamps | ASR (AssemblyAI / Deepgram / Whisper) |
| **WHO** — named speakers, even through interruptions/crowds | Multimodal LLM (Gemini, reading audio + video keyframes + context) |
| **HOW** — tone, emotion, pauses | Multimodal LLM |
| Clean text / fixing ASR errors | Multimodal LLM |

offmute-v2's job is to **fuse** them: get the rich diarized transcript from the LLM, get the timing from the ASR, and **align** the two so every speaker turn lands on the right millisecond.

## Diarization levels (goal: 3)

1. Speaker separation — who speaks when.
2. Anonymous but consistent — Speaker A/B, stable across the whole transcript.
3. **Identification** — actual names inferred from context (may require multiple passes; a speaker might only name themselves once).

## Outputs

- Diarized **SRT** (speaker-labelled; turn-broken or display-sized blocks).
- **Markdown** transcript (with tone annotations).
- Raw JSON (segments with speaker, timing, confidence, tone) for downstream use.

## Architecture (planned — see SPEC)

```
input (audio/video [+ instructions])
   │
   ├─ preprocess (ffmpeg): downsample 16k mono audio, keyframes, chunks  →  intermediates/
   │
   ├─ ASR pass        → word-level timestamps + candidate speaker turns   (timing track)
   ├─ LLM pass        → diarized transcript w/ names + tone (per chunk)    (content track)
   │
   ├─ align           → assign ASR timestamps to LLM turns (fuzzy/DP)
   ├─ merge chunks    → dedup overlaps, reconcile speakers across chunks
   ├─ identify        → resolve speaker names globally (multi-pass)
   │
   └─ format          → SRT / Markdown / JSON
```

Every stage writes intermediates to disk (hash-keyed) for debugging + resume.

## Dev

```bash
bun install          # or npm install
bun run src/cli.ts   # dev run
npm run typecheck
npm run build        # tsup → dist (npm + browser bundles)
```

Requires `ffmpeg`/`ffprobe` on PATH (Node CLI). Browser build will use ffmpeg.wasm.

## API keys

Read from env or injected: `GEMINI_API_KEY`, `ASSEMBLYAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`. Only the ones for the providers you use are required.

## Credit / lineage

Learns from three predecessors (in `../inspirations/`): **offmute** (multimodal describe→transcribe→report, tone), **ipgu** (chunk/overlap/merge discipline, timestamp validation, reference-anchoring), **meeting-diary** (AssemblyAI word timestamps + diarization, hash caching, best-example speaker ID).
