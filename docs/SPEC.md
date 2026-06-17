# offmute-v2 — Specification & Plan

Status: v1 design, architecture empirically validated (see process log Entry 3).

## 1. Goal

Input: an audio/video file (+ optional natural-language instructions).
Output: a **timestamp-correct, diarized transcript** with speaker names (when inferable) and tone annotations, available as **diarized SRT**, **Markdown**, and **JSON**.

Hands-off by default; tunable (model tiers, number of passes, which modules run, instructions). Resumable from disk intermediates. Runnable as an npx CLI and (core) in the browser.

### Diarization success levels (target: 3)
1. separation (who-speaks-when) · 2. anonymous-consistent (Speaker A/B) · 3. **identification** (real names from context).

## 2. Why this architecture (validated)

| Need | Tool | Evidence |
|------|------|----------|
| precise WHEN (word timestamps) | **ASR** (AssemblyAI) | sub-second, matches GT; but diarization unreliable on interjections |
| WHO / HOW (names, tone, hard audio) | **multimodal LLM** (Gemini) | separated speakers + inferred "Rishi" where ASR merged; tone captured; but timestamps coarse (mm:ss) and drift +4.5min/32min |
| fuse them | **token alignment** | WER 8.4%, speaker 99.5%, drift erased, boundaries match GT |

**Principle:** the LLM owns *content + diarization + identity + tone*; the ASR owns *time*; alignment marries them. Never trust LLM timestamps for output; never trust ASR diarization as authority (use as hint).

## 3. Pipeline

```
input (audio/video [+ instructions])
  │
  1. PROBE + PREPROCESS (node ffmpeg / browser ffmpeg.wasm)
  │    → 16k mono audio (full + per-chunk), keyframes (video), MediaInfo
  │
  2. ASR PASS (timing track)            3. CONTEXT PASS (optional, video)
  │    AssemblyAI → words[], utterances[]    keyframes+tag-audio → meeting description
  │    (precise times + speaker hints)        (who/topics; offmute "describe")
  │
  4. DIARIZE PASS (content track)
  │    Gemini(audio [+keyframes] + description + ASR-hint + instructions)
  │    → turns[{speaker, tone, text, approxStart}]  (chunked if long; overlap)
  │
  5. ALIGN
  │    map each LLM token → ASR word time; cut turns into sub-segments
  │    (sentence / subtitle-sized) with REAL word times; flag low-match spans
  │
  6. MERGE (if chunked)
  │    dedup overlap regions (ipgu: prefer later/より-confident), stitch turns
  │
  7. IDENTIFY (speaker resolution, multi-pass)
  │    canonicalize labels across whole transcript; resolve names from any
  │    self-identification; apply instruction-driven grouping (e.g. "audience")
  │
  8. FORMAT → SRT (turn or display-sized) / Markdown / JSON
```

Every stage writes intermediates to disk (hash-keyed) and can resume.

## 4. Data model

See `src/types.ts`. Tracks: `AsrResult` (words/utterances), `LlmLine` (pre-align turns), fused `Transcript`(`segments[] + speakers[]`). `TranscriptSegment` carries `timingSource` + `alignmentConfidence` for provenance.

## 5. Alignment (core/align.ts)

- Normalize tokens (lowercase, strip non-alphanumerics).
- Global Needleman–Wunsch on `[LLM tokens]` vs `[ASR words]` (match +2, mismatch/gap −1). O(n·m), fine per-chunk; for whole-file we align per chunk or band.
- **Per-token time map**: each LLM token → matched ASR word `start/end` (or null). (Refactor target: expose this, not just per-turn min/max.)
- Build output segments by grouping LLM tokens at chosen granularity (turn → sentences → subtitle-sized), reading start=first matched word.start, end=last matched word.end; interpolate gaps from neighbors monotonically.
- **Confidence** = fraction of segment tokens that matched an ASR word. Low → flag (LLM hallucination or ASR gap); drop word-less "turns" (applause).

### Sub-segmentation for display SRT
Within a turn, split on sentence terminators and/or ASR gaps > ~0.7s, and cap cue length (~ <= 7s / ~84 chars / 2 lines). Keep speaker label. Long monologues become many readable cues, all same speaker, each with real word times.

## 6. Speaker identification (multi-pass)

1. Collect Gemini's per-turn labels across the (merged) transcript.
2. Canonicalize: cluster label variants (Rishi≈Hrishi) by name similarity + ASR-speaker co-occurrence.
3. Resolve names: scan for self/other identification ("my name's Rishi", "thanks, Matthew"); a pass with the *whole* transcript + best example turns per speaker (meeting-diary's longest-segment sampling) asks the LLM to produce a `{label → canonical name + role}` map.
4. Apply instruction-driven grouping (e.g. "one speaker on stage = Hrishi, everyone else = Audience"). Default heuristic if no instructions: keep distinct names; group clearly-audience interjections.
5. Optional human-in-the-loop override (CLI prompt / API param `knownSpeakers`).

## 7. Chunking (long files)

- ≤ ~30 min: single Gemini pass (validated; maxOut 65536 + thinkingBudget bounded).
- Longer: chunk audio (~15 min, ~2 min overlap). ASR runs whole-file (cheap, no chunk needed). Gemini per chunk with: description + previous-chunk tail + ASR-hint for the chunk. Align each chunk to the whole-file ASR words restricted to the chunk's time window. Merge: dedup overlap by time+text (prefer the chunk where the turn is internal, not edge).
- Concurrency-limited (ipgu queue pattern).

## 8. Failure modes & detection

| Failure | Detection | Mitigation |
|---------|-----------|------------|
| LLM timestamp drift | n/a (expected) | alignment ignores them |
| LLM hallucinated text (no audio) | segment match ratio ≈ 0 | drop / flag |
| ASR word gap (music/noise) | LLM tokens unmatched in a span | interpolate; mark low-confidence |
| LLM skips/compresses (long single pass) | aligned coverage << duration; big unmatched ASR span | chunk smaller; retry (ipgu span-validation) |
| Diarization wrong | low speaker agreement vs ASR turns; identify-pass sanity | refine pass w/ pro model |
| Chunk boundary dup/seam | overlapping segments same text | merge dedup |

## 9. Config / API surface

```ts
transcribe(input, {
  instructions?, asr?: 'assemblyai'|'none', asrModel?,
  llm?: 'gemini-flash-latest'|'gemini-pro-latest'|..., llmThinkingBudget?,
  useVideo?: boolean, keyframeCount?,
  chunkMinutes?, chunkOverlapMinutes?,
  identifySpeakers?: boolean, knownSpeakers?: Record<label,name>,
  passes?: number,                  // refinement passes
  intermediatesDir?, cache?: boolean, onProgress?,
  apiKeys?: { gemini?, assemblyai?, ... },
}) → Transcript  (+ toSRT/toMarkdown/toJSON)
```

Keys from env or injected. Stoppable → returns best-so-far.

## 10. Packaging

- **CLI** (`offmute-v2 input [opts]`): node, ffmpeg via spawn. Real-time progress, incremental file writes (offmute pattern).
- **Library** (node): full pipeline.
- **Browser** (`offmute-v2/browser`): core (align/srt/eval/format/prompts) is pure & bundles clean; ffmpeg.wasm for preprocess; fetch-based provider calls. ASR/LLM keys injected by host.

## 11. Eval methodology

`core/eval.ts`: WER + word-level speaker accuracy (optimal label mapping) + timestamp error, vs reference SRT. Caveats: reference word-times interpolated within long cues → trust *boundary* error on short cues. Always also **read** the transcript. Track metrics per change in `intermediates/eval/`.

## 12. Build order / status

1. ✅ `align.ts` → per-token time map + sub-segmentation.
2. ✅ `pipeline.ts` orchestrator (probe→asr→diarize→align→segment→identify→format) + intermediates/cache/resume.
3. ✅ Output formatters (SRT turn/display, Markdown, JSON, text).
4. ✅ Speaker-identify pass (LLM merge + voice-anchored canonicalization).
5. ✅ CLI (`offmute-v2`).
6. ✅ Chunking for long files + overlap merge (validated: chunked ≈ single-pass).
7. ✅ Browser entry (pure 32KB `core/assemble.ts` + `browser.ts`). ⏳ ffmpeg.wasm preprocessing + fetch providers left to the host (documented).
8. ✅ README/docs, fresh-eyes code review applied, retries, 29 tests, strict tsc, tsup build.

### Validated results
- talk (32min, ground truth): single-pass **WER 8.1% · speaker 98.7% · boundary median 0.04s / p90 0.43s**; chunked WER 8.4% / speaker 99.0% / boundary 0.06s.
- podcast (41min, unseen, no instructions): auto-identified 5 named speakers correctly, chunked + video.

### Known limitations
- Chunk overlap merge is heuristic (time + text Jaccard). Principled fix: dedup on global ASR-word-index spans. Empirically clean, deferred.
- `assignTimings`/`interpolateTimings` (align.ts) superseded by the token path; kept for `scripts/test-align.ts`.
