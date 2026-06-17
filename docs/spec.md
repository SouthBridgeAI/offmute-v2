# offmute-v2 — Spec & Plan

> Living document. Crystallizes the multi-pass design, hypotheses, failure handling,
> and the interface. Re-read alongside the process log when context compresses.

## 1. Goal

Input: a video/audio file (+ optional free-form instructions, + optional known speakers).
Output: a **timestamp-correct, diarized transcript** with tone/behavior labels, in SRT,
Markdown, and JSON. Stoppable/resumable; passes selectable.

## 2. Core hypothesis

> **A multimodal LLM produces the best *content* (accurate words, tone, diarization
> through interruptions, speaker identification via context); a timestamped transcriber
> produces the best *timing*. Aligning the two (word-level edit distance) yields a
> transcript that is better than either alone.**

Sub-hypotheses (each tested by a script before committing to it):
- **H1** Gemini can transcribe+diarize a chunk with tone + relative `mm:ss` timestamps
  that are *coarsely* correct (within a few seconds), good enough to gate alignment.
- **H2** AssemblyAI gives accurate word-level timestamps + clean speaker separation
  over the whole file without chunking.
- **H3** Word-level edit-distance alignment (ts-aligner approach) transfers accurate
  timestamps from the ASR words onto the LLM text with <0.5s median error vs ground truth.
- **H4** Carrying a canonical speaker roster + last-N-lines context across chunks keeps
  speaker labels consistent without an overlap-dedup crutch.
- **H5** DeepSeek (text-only, cheap) can identify speakers and repair alignment gaps
  from context better/cheaper than a second audio pass.
- **H6** Silence-aware chunk boundaries (cut at low-energy points) reduce mid-word cuts
  and make overlap dedup cleaner than fixed time windows.

## 3. Pipeline (passes — each selectable, each writes intermediates, each resumable)

```
preprocess → describe → llm-transcribe → timestamped → align → consistency → [identify] → finalize
```

### 3.1 preprocess
- Extract audio: mono, 16 kHz, 32-bit float → FLAC or 64k Opus (small, lossless-ish,
  Gemini-friendly). Never operate on raw PCM `.mov` (9.6GB!).
- (Video) extract N keyframes (scene-change detection preferred over even spacing) at
  720p JPG for the describe pass.
- Outputs: `intermediates/audio.<ext>`, `intermediates/keyframes/*.jpg`, `probe.json`
  (duration, streams).

### 3.2 describe
- Multimodal LLM (Gemini) over an audio sample (more than offmute's 20min — e.g. first
  5min + a few scattered 2min samples, or the whole file if it fits context/cheap model)
  + keyframes → produces a **speaker roster** (descriptions, roles, accents, hints) and
  a meeting summary. This roster is the anchor for cross-chunk consistency.
- Output: `intermediates/description.json`.

### 3.3 llm-transcribe (per chunk, concurrent)
- Chunk the preprocessed audio with overlap (default 10min / 1min). **H6: nudge
  boundaries to nearby silence** (ffmpeg `silencedetect`) within a tolerance window.
- For each chunk: Gemini prompt = description + speaker roster + last-N-lines of
  previous chunk + instructions → output **structured** diarized segments with relative
  `mm:ss - mm:ss` timestamps, speaker label (from roster), tone tags, text. Use a
  strict parseable format (XML or JSON, ipgu-style) — NOT free markdown.
- Validate each chunk: span ≥ 75% of chunk duration (ipgu), ≥ min segments, timestamps
  monotonic. Retry on validation failure (ipgu pattern). Save raw + parsed.
- Carry-forward: the roster (stable) + last ~N segments of previous chunk (continuity).
- Outputs: `intermediates/llm/chunk_NN_raw.txt`, `chunk_NN_parsed.json`.

### 3.4 timestamped (whole file, no chunking)
- Primary: AssemblyAI (`speaker_labels`, word-level timestamps, `utterances`).
- Fallbacks: Whisper via Groq (word timestamps), WhisperX in a container (local/free).
- Caches by content hash (meeting-diary pattern) so iteration doesn't re-pay.
- Output: `intermediates/timestamped.json` — array of `{start,end,speaker,text,words[]}`.

### 3.5 align
- For each LLM segment: take its coarse time window (relative ts + chunk offset) and
  the ASR words overlapping that window; **word-level edit-distance align** the LLM
  segment text to the ASR words (ts-aligner algorithm). Transfer ASR word times onto
  LLM words; segment start = first matched word start, end = last matched word end
  (interpolate for inserted LLM words).
- Speaker: prefer the LLM speaker (richer, identified); fall back to the ASR speaker
  for the same time region if LLM speaker is ambiguous. Record `timingSource`.
- Confidence: alignment match ratio. Flag low-confidence segments for the repair pass.
- Output: `intermediates/aligned.json` — segments with accurate absolute times.

### 3.6 consistency
- Map per-chunk LLM speaker labels → **global consistent labels** (speaker_0, speaker_1,
  …). Use voice-region overlap from the timestamped diarization as a bridge: if LLM
  "Speaker A" in chunk 2 overlaps ASR speaker "B" predominantly, and chunk 1's LLM
  "Speaker A" overlapped ASR "A", they're different people → relabel. (Level 2.)
- Output: `intermediates/consistent.json`.

### 3.7 identify (optional, level 3, multi-pass)
- DeepSeek (cheap text reasoner) over the consistent transcript + description + roster:
  infer names/roles from content ("my name is Rishi", "I run Southbridge"). A speaker
  may self-identify in only one chunk → must see the whole transcript. One pass to
  propose, one pass to apply + sanity-check. Known-speakers input short-circuits this.
- Output: `intermediates/identified.json` (speaker names + evidence).

### 3.8 finalize
- Merge chunks (already done by align, but dedup any overlap-region duplicates via
  `trustedStart` + fuzzy match — the offmute/ipgu weakness, now fixed).
- Overlap resolution: sort by start; if `cur.end > next.start`, shorten `cur.end` to
  `next.start − gap` while keeping `cur ≥ MIN_DUR`; then **a final re-check pass**
  (fixes ipgu's known clamp-reintroduces-overlap gap).
- Clamp durations to [MIN_DUR, MAX_DUR]. Apply SRT-breaking policy (§5).
- Write `output/<name>.srt`, `<name>.md`, `<name>.json`.

## 4. Failure handling & detection (instr. #6: "how would we know if they fail")

| Failure | Detection | Recovery |
|---|---|---|
| LLM chunk span too short / few segments | validation (§3.3) | retry w/ stricter prompt; then mark chunk failed, fill from timestamped-only for that region |
| LLM unparseable output | parser returns 0 entries | retry; fall back to lenient regex parse; then timestamped-only |
| AssemblyAI failure/error | API status | retry w/ backoff; fall back to Whisper/Groq; then LLM-relative timestamps only (degraded) |
| Alignment low confidence (match ratio < θ) | per-segment confidence flag | send flagged segments + ASR + LLM text to DeepSeek repair pass; else keep LLM coarse timestamps |
| Speaker inconsistency | consistency pass detects ambiguous overlaps | bump to identification pass; else leave anonymous-consistent |
| Cumulative: output too sparse | final segment count vs expected | report which stages degraded; never silently emit a thin transcript |

**Eval (objective):** a scorer compares output SRT ↔ `test-files/1` reference SRT:
- **Text:** word-level WER against the reference text (speaker-attributed).
- **Timing:** median + 95th-pct absolute error of segment start/end vs nearest reference.
- **Diarization:** speaker-label agreement (confusion matrix → accuracy / DER-ish).
Run after each meaningful change. The reference is hand-checked, so this is ground truth.

## 5. SRT-breaking policy (instr. #13)

- Break at **speaker changes** (each block = one speaker).
- Within a speaker run, split when block exceeds **readability limits**: > ~42 chars
  or > ~7s (subtitle reading-speed). Merge consecutive same-speaker blocks shorter than
  ~1.2s into the neighbor.
- Label speaker at the start of each block; tone as a trailing ` (tone)` note (toggleable).
- Compare against the reference SRT (which breaks at speaker changes, with some very
  long Hrishi blocks) to validate the readability tradeoff.

## 6. Interface

### CLI
```
npx offmute-v2 <input> [options]
  --passes <list>          preprocess,describe,llm-transcribe,timestamped,align,consistency,identify,finalize
  --level <1|2|3>          diarization depth
  --formats <srt,md,json>
  --instructions <text>
  --speakers <names...>    known speakers (skip identify)
  --chunk-seconds <n>      default 600
  --overlap-seconds <n>    default 60
  --timestamped <prov>     assemblyai | whisper-groq | whisperx | none
  --model <name>           override LLM transcribe model
  --reasoner <name>        override text-reasoner (default deepseek-chat)
  --only-chunk <n>         debug a single chunk
  --force                  reprocess cached intermediates
  --resume                 (default) reuse existing intermediates
```

### Library
```ts
import { transcribe } from "offmute-v2";
const result = await transcribe("meeting.mov", {
  passes: [...], level: 3, instructions: "...",
  apiKeys: { gemini: "...", assemblyai: "..." }, // injectable (instr. #11)
});
// result.segments: Segment[]; result.speakers; result.metadata
```

## 7. Build order (test-each-part first, instr. #5)

1. ffmpeg wrapper + preprocess script → prove audio extraction + keyframes + probe.
2. Gemini provider + llm-transcribe script on one chunk → prove H1 (parse, validate).
3. AssemblyAI provider + timestamped script on the whole file → prove H2.
4. Aligner (unit-tested on synthetic + real pair) → prove H3.
5. Consistency + identify (DeepSeek) scripts → prove H4/H5.
6. Finalize (overlap fix + SRT/MD/JSON) + eval scorer → prove end-to-end + measure.
7. Wire into pipeline orchestrator (resumable, concurrent, intermediates).
8. Iterate against the reference SRT until metrics are strong.
9. Package (npx + browser).

## 8. Non-goals (for now)

- Real-time/streaming transcription (offline only).
- Translation (ipgu's domain) — out of scope, but the alignment infra supports it later.
- A GUI — CLI + library only.
