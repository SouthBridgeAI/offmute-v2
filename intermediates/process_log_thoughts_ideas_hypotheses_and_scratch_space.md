# Process Log, Thoughts, Ideas, Hypotheses & Scratch Space

> **Append-only.** Date every entry. This is the long-term memory for the project —
> hypotheses, findings, gotchas, things to come back to. Re-read when context compresses.

---

## 2026-06-17 — Project kickoff & inspiration study

### Goal (from `0-starting-instructions.md`)
Build the best diarized meeting-transcription system. Inputs: video/audio + optional
instructions. Output: timestamp-correct, diarized transcript with tone/behavior labels.
Combines **multimodal LLM** strengths (tone, video+audio context, speaker ID through
interruptions, crowded-room listening) with **timestamped transcriber** accuracy.
Must do SRTs + alignment (offmute can't). Must improve chunking/overlap handling
(a known weakness across all three inspirations). Package for npx + browser.

### Environment available
- node v20.11.1, npm 10.2.4, ffmpeg 8.0.1, git 2.50.1, docker 29.4 (orbstack).
- API keys present: ANTHROPIC, ASSEMBLYAI, DEEPSEEK, GEMINI/GOOGLE, GROQ, OPENAI,
  GLM, KIMI, ZAI, plus a bunch of others (EXA, FIRECRAWL, etc. for research).
- Test files:
  - `test-files/1/talk-with-questions.mov` — 1913.5s (~32min), 1080p, **PCM 24-bit
    48kHz stereo** (9.6GB — huge because uncompressed audio). Reference SRT present,
    speakers "Hrishi" + "Audience" (talk + Q&A, interruptions). **Ground truth.**
  - `test-files/2/...Satya-Nadella...1080p.mp4` — 2486s (~41min), 1080p, AAC 44.1kHz
    (702MB). No reference SRT. Podcast (good for multi-speaker test).

### Inspiration 1: `offmute` (the workhorse, LLM-only, no timestamps)
- **Pipeline:** screenshots + audio-tag-sample → Gemini description (merged) →
  per-chunk Gemini transcription → optional report ("Spreadfill": headings then
  fill each section independently with full context).
- **Diarization format:** `~[Speaker Name]~: text` (markdown-ish). Tone/emotion
  inline: "(silently contemplating, hesitant)".
- **Chunking:** 10min chunks, **1min overlap**, MP3 44.1kHz 192k, **stereo** (wasteful).
  Overlap is transcribed twice with **NO dedup** — the user's explicit pain point.
- **Context carry across chunks:** last 20 lines of previous transcription only.
  Fragile — speaker labels can drift, content can be lost/repeated at boundaries.
- **Description step uses only first 20min ("tag sample")** to guess who speakers are.
  Weak for long meetings where speakers appear later.
- Gemini client (`utils/gemini.ts`): uploads file via FileAPI, polls until PROCESSED,
  maxOutputTokens 65536 for 2.5/3 models, cleanup uploaded files in `finally`.
  Retry wraps the whole upload+generate. Good pattern to reuse.
- Models now include gemini-3-pro-preview etc.
- `PROBLEMS.md` is a Claude code review listing missing validation, no cleanup on
  error, path-traversal risk in output paths, no diarization validation, magic
  numbers. `TODO.md`: merge whisper transcriptions, smarter screenshots, the
  "transcription folder next to video" bug.

### Inspiration 2: `ipgu` (timestamps + overlap handling + XML, translation-focused)
- **Pipeline:** split (media + ref SRT) → transcribe (Gemini, relative timestamps) →
  translate (Gemini/Claude, XML output) → parse+validate → finalize (merge/overlap/SRT).
- **Transcription prompt asks for RELATIVE `mm:ss - mm:ss` timestamps**, explicitly
  "Don't worry about getting the timestamps correct - but transcribe all that you can."
  → coarse timing, validated to span ≥75% of chunk duration (MIN_SPAN_COVERAGE_RATIO).
- **Relative→absolute:** `adjustTranscriptTimestamps` adds chunk.startSeconds to each
  `mm:ss` range, reformats to `HH:MM:SS,mmm`. Simple + robust.
- **Chunking (`time_utils.calculateChunks`):** step = chunkDur - overlap; if last chunk
  would be < 1/3 of chunkDur, merge its tail into the previous chunk. Good.
- **Overlap resolution (`finalizer`):**
  1. Dedupe by `originalId`, **keep the entry from the LATEST chunk**.
  2. `fixAndClampTimings`: sort by start; iteratively (≤10 passes) if `cur.end >
     next.start`, set `cur.end = min(cur.start+MAX_SUB, next.start - 50ms)` but only
     if that keeps `cur` ≥ MIN_SUB_DURATION (0.5s); else leave overlap + warn.
     Constants: MIN_SUB=0.5s, MAX_SUB=7.0s, OVERLAP_GAP=0.05s.
  3. Clamp all durations to [0.5s, 7.0s]. **Known gap:** clamping can re-introduce
     overlaps (noted in a comment) — no final re-check pass. **I should add one.**
- **XML structured output:** `<subline><original_number>..</original_number>
  <original_line>..</original_line><original_timing>..</original_timing>
  <better_english_translation>..</better_english_translation>
  <{lang}_translation>..</{lang}_translation></subline>`. Parser handles both
  markdown-fenced and direct tags, tracks issues (DuplicateId, MalformedTag,
  InvalidTiming, etc.) with line numbers + context snippets. Very robust — reuse.
- **Resilience:** multi-level retries (API + validation), `--force` to reprocess,
  `-P/--part` to process a single chunk (great for debugging), per-chunk status
  state machine, cost tracking (tokens × $/M from `config/models.ts`), concurrency
  cap (`maxConcurrent`), file logging. All worth reusing.
- **Weakness for our purpose:** translation-focused, relies on a reference SRT for
  accurate timing (LLM timings are coarse). No diarization/speaker-ID, no tone.
  But the timestamp mechanics + overlap handling + XML parsing are gold.

### Inspiration 3: `meeting-diary` (AssemblyAI: accurate timestamps + basic diarization)
- Uses AssemblyAI: upload file → `transcripts.create({ audio_url, speaker_labels:
  true, speakers_expected })` → poll until `completed` → read `result.utterances`
  (each: speaker "A"/"B", text, start/end in **ms**, confidence).
- Speaker label mapping: `speaker_${utterance.speaker.charCodeAt(0) - 64}` (A→1…).
- **Interactive speaker ID:** `findBestExamplesForSpeaker` picks the N longest
  segments per speaker, shows with before/after context, prompts for name. Good UX
  idea — but we want LLM-driven identification, not interactive.
- **Hash-based caching** (sha256 of file → cache audio URL, transcript id, full
  transcript). Reuse: avoids re-uploading/re-transcribing during iteration.
- Output: md (timestamped, speaker list, chronological), srt, txt, json.
- **Weaknesses:** no tone/emotion, no video context, manual speaker ID, API-only
  (not browser-runnable), costs $/min, speaker **separation** only (A/B/C) not
  identification. But it is the gold standard for **accurate word-level timestamps +
  clean diarization** of whole files (no chunking needed — AssemblyAI handles long audio).

### The synthesis (offmute-v2 strategy)
Combine all three into a multi-pass hybrid:
1. **Preprocess** — extract audio (mono 16kHz for speech, downsample to save tokens/
   bandwidth), extract keyframes/screenshots for video context. *(instr. #10)*
2. **Description pass** — multimodal LLM describes the meeting from audio sample +
   screenshots → speaker roster + context. Like offmute but sample more than 20min.
3. **LLM transcription pass** (Gemini multimodal, per chunk) — diarized, tone-annotated,
   with relative `mm:ss` timestamps (ipgu-style), **speaker-consistent labels carried
   across chunks** (offmute-style but stronger: pass the canonical speaker roster +
   last-N-lines context). Validates span ≥ threshold (ipgu-style).
4. **Timestamped pass** (AssemblyAI preferred; Whisper via Groq/OpenAI as fallback) —
   accurate word/utterance-level timestamps + basic speaker separation over the
   **whole file** (no chunking). This is the timing ground truth.
5. **Alignment** — fuzzy-text-match (then maybe embeddings) LLM utterances ↔
   timestamped utterances to stamp accurate times onto the rich LLM text. *(instr. #12,
   start coarse then close.)*
6. **Speaker-consistency pass** — map per-chunk speaker labels → global consistent
   labels (A/B or by voice). Diarization level 2. *(instr. #9.2)*
7. **Speaker-identification pass** (optional, LLM, multi-pass) — use context to name
   speakers. Level 3. DeepSeek (cheap reasoner) is great for this text task. *(#9.3)*
8. **Finalize** — overlap resolution (ipgu-style + **final re-check pass**), duration
   clamping, format as **diarized SRT** (speaker labels + tone), **markdown**, **JSON**.
9. Save all intermediates; resumable by checking for existing chunk outputs. *(#8)*

### Model assignment hypothesis (rich key set → cheap/strong split)
- **Multimodal audio transcription** (needs ears): Gemini 2.5 Pro/Flash (native audio,
  huge context, tone) — primary. GPT-4o-audio / openai gpt-4o-transcribe as alt.
- **Timestamped transcription**: AssemblyAI (best diarization+timestamps, whole-file).
  Whisper via Groq (fast/cheap) or OpenAI as fallback.
- **Text reasoning passes** (speaker ID, consistency, refinement, alignment repair,
  description merge): **DeepSeek** (cheap, strong reasoner, OpenAI-compatible) —
  primary. Claude/GPT-4o for quality-critical.
- DeepSeek CANNOT hear audio — only use for text passes. Important constraint.

### Diarization levels (instr. #9) — target all three, selectable
1. Separation (who-when) — timestamped pass alone gives this.
2. Anonymous-but-consistent (A/B throughout) — consistency pass.
3. Identification (named) — identification pass, multi-pass because a speaker may
   self-identify in only one chunk.

### SRT breaking (instr. #13) — decision pending
Options: (a) break SRT blocks at speaker changes/interruptions; (b) keep longer
blocks, label speakers within. Constraint: each block must be readable (not too thick).
**Hypothesis:** break at speaker changes AND cap block duration/char-count for
readability; merge consecutive same-speaker short utterances. Will A/B against the
reference SRT (which breaks at speaker changes, with some very long Hrishi blocks).

### Things to come back to / not yet decided
- **Chunk boundary placement:** offmute/ipgu use fixed time windows. Could improve by
  cutting at low-energy/silence points (ffmpeg silencedetect) so overlaps fall on
  natural pauses → cleaner dedup + less mid-word cuts. **Try this.**
- **Overlap dedup mechanism:** ipgu dedupes by `originalId` (from ref SRT). We have no
  ref SRT. Plan: use `trustedStart` per chunk (content before trustedStart is
  overlap-with-previous and gets dropped) + fuzzy dedup of any remaining duplicates.
- **Browser packaging:** needs ffmpeg.wasm + browser-friendly providers (no fs, no
  AssemblyAI upload-from-path). Defer to packaging phase; keep core/provider split clean.
- **Embeddings for alignment:** if fuzzy text match insufficient, use sentence
  embeddings (or even Gemini text-embedding) to match LLM↔timestamped. Defer.
- **Testing/eval:** build a scorer comparing output SRT ↔ reference SRT (WER-ish on
  text, timing error, speaker-label accuracy). Essential for "how do we know if it
  failed" (instr. #6). Use test-files/1 as the eval set.

### Non-intuitive gotchas so far
- Test video 1 is 9.6GB because audio is **uncompressed PCM 24-bit**. Must transcode
  to compressed mono 16kHz before any upload — never upload the raw .mov.
- Gemini File API requires polling `FileState.PROCESSING` → ACTIVE before generate;
  cleanup uploaded files or they accumulate against quota (offmute does this in finally).
- ipgu's overlap clamp can re-introduce overlaps — noted but unfixed upstream.
- offmute carries only last 20 lines as cross-chunk context — too fragile for speaker
  consistency; pass an explicit speaker roster instead.

---

## 2026-06-17 — State-of-the-art research (via Exa/Firecrawl; built-in WebSearch was non-functional)

### Gemini diarization (gemilab guide, May 2026)
- Gemini 2.5 Pro/Flash (and now 3.5 Pro/Flash, current as of Jun 2026) accept audio as
  multimodal input and **can diarize** by combining **timbre cues + conversation flow**
  — NOT pure voiceprint. Key lever: **passing speaker names/roles into the prompt
  boosts accuracy noticeably** (uses what-is-said as well as how-it-sounds).
- **Fails on similar-sounding voices / heavy ambient noise** → dedicated diarizers
  (pyannote, AssemblyAI) win there. Confirms the hybrid split.
- Implication for us: Gemini is great for diarization *with context* (we pass the
  description/roster), and AssemblyAI is the backstop for hard audio + accurate timing.

### ⭐ ts-aligner — the alignment solution (github.com/theirstory/ts-aligner, Apache-2.0)
- JS library, **works in Node AND browser**, no build step. Solves EXACTLY our problem:
  - Machine transcript (ASR: has word-level timing, has errors) = our AssemblyAI/Whisper output
  - Corrected transcript (no timing, better text) = our LLM diarized output
  - Produces corrected text WITH accurate timing, preserving speaker labels + paragraphs.
- **Algorithm:** EXTRACT (words from both) → ALIGN (DP Levenshtein/edit-distance on word
  sequences; matches/substitutions/insertions/deletions) → TRANSFER (match/sub → original
  timing; inserted → interpolate from neighbors; deleted → skip) → RECONSTRUCT (paragraphs,
  attach timing). Punctuation-aware, case-insensitive, speaker-label-preserving.
- This is the "fuzzy search, start coarse" from instr. #12, validated and production-shaped.
- **Decision:** implement our own clean aligner informed by this algorithm (we need to handle
  tone annotations + named speakers that aren't in the ASR transcript). Vendor as reference.
  License-compatible (Apache-2.0). Keep browser-compatible (helps packaging goal).

### WhisperX (arxiv 2303.00747) — the SOTA local pipeline
- Whisper → **forced alignment (wav2vec2 CTC)** for accurate WORD-level timestamps →
  **pyannote diarization** → VAD. Phoneme-level timing accuracy. Best open-source combo.
- Python/torch — great in a container (orbstack available) but complicates Node/browser.
  Use as a *container* option for self-hosted/cheap runs; AssemblyAI as the *API* option.

### pyannote.audio 3.0 (Sep 2023) — SOTA open diarization
- VAD + speaker segmentation + clustering + overlap handling. The reference diarizer.
- Python. Could run in container for the "separation" level without an API.

### AssemblyAI — timestamped API (current docs)
- `speaker_labels` diarization, **word-level timestamps + confidence**, utterances.
- **"Speaker Identification for existing transcript"** endpoint — identify speakers given a
  transcript. Could complement the LLM identification pass.
- Universal-2 model (late 2024) = best accuracy. Whole-file (no chunking needed).
- Use as primary timestamped provider (handles long audio, accurate, diarized).

### Groq — fast/cheap Whisper
- `whisper-large-v3-turbo`, very fast, very cheap, word timestamps. Good fallback/cheap
  timestamped provider via Whisper. OpenAI-compatible API.

### DeepSeek — confirmed text-only (no audio)
- V3 / R1 are strong, cheap text reasoners. **Cannot hear audio.** Use only for text passes
  (description merge, speaker ID, consistency, alignment repair, refinement). Confirmed.

### Alignment technique ladder (instr. #12: coarse → close)
1. **Word-level edit distance (Levenshtein)** — ts-aligner approach. Start here. Cheap, exact
   for near-matches, handles insertions/deletions/substitutions. No deps, browser-safe.
2. **Temporal-gated fuzzy match** — constrain candidate ASR words to LLM utterance's
   coarse time window (from LLM relative timestamps + chunk offset) before edit-distance,
   to avoid cross-talk misalignment. Big accuracy win, cheap.
3. **Embedding DTW** — only if (1)+(2) insufficient: sentence-embedding DTW to align
   utterance sequences, then word edit-distance within. Heavier (needs embedding model).
   Defer until proven necessary.

### Model availability note (June 2026)
- Env banner (gemilab) indicates Gemini 3.5 Pro/Flash are current. My presets list
  gemini-3-pro-preview; **verify available model ids against the API at build time** and
  add gemini-3.5-pro / gemini-3.5-flash. The `@google/genai` SDK's `models.list()` can
  confirm what the key can call.

### Things to come back to
- ts-aligner full algorithm details (TIMING TRANSFER edge cases, overlap prevention) — fetch
  the rest of word-alignment.js when implementing the aligner.
- AssemblyAI "speaker identification for existing transcript" — read docs; may let us name
  speakers via their API given our LLM transcript (alternative to DeepSeek ID pass).
- WhisperX in a Docker container (orbstack) as a free/local timestamped+diarized backend.

---

## 2026-06-17 — Build phase: preprocess verified, silence-threshold gotcha

### preprocess script (H6 partial) — WORKS
- 9.6GB PCM `.mov` → **76.3MB mono 16kHz FLAC in 1.8s**. Never touch the raw file again.
- 4 chunks of 600s/60s overlap planned; `trustedStart` correctly = start+overlap. Good.
- Scene-aware keyframes work (6 frames) but took 76s (input-seek on huge PCM `.mov` is
  slow). Acceptable (once per file). Optimize later: single-pass `select`+`frame_pts`.

### ⚠️ Silence detection threshold gotcha
- `silencedetect=noise=-30dB` (offmute/ipgu-style default) found **0 ranges** here.
  Recording is HOT: mean_volume **-16.1 dB**, max -1.0 dB, noise floor ~-12 dB (live talk
  w/ audience ambient). Audio never drops below -30dB.
- **-12dB / 0.25s → 443 ranges** (~1 per 4s) — usable for boundary snapping.
- **Fix:** default -30dB is wrong for normalized/hot speech. Pipeline should try -30dB,
  and if < ~3 ranges found, retry at -15dB then -12dB. Or auto-derive from volumedetect.
  Add a `meanVolume()` helper + adaptive threshold later. For now use -15dB/-12dB on this file.

### Next: Gemini llm-transcribe on one chunk (H1) — the critical test

### H1 VERIFIED ✅ — Gemini chunk transcription (gemini-2.5-flash, 5min chunk)
- 56 segments, full 300s span, ~16.7k tokens (9.97k in / 4.1k out). Pennies per chunk.
- **Diarization correct**: identified "Presenter" + "Audience" = matches reference
  Hrishi/Audience. Caught the audience interruption at 9s ("speaker is from NU as well").
- **Verbatim** w/ fillers ("uh", "it's it's it's"). Picked up self-ID cue "my name is
  Rishi, I run a company called Southbridge" at 0:46 → gold for the identify pass.
- Timestamps coarse (integer seconds) + boundaries differ from ref (LLM breaks more
  granularly; ref has one 73s block). → confirms alignment pass (H3) needed for timing.
- JSON structured output (responseSchema) parsed cleanly, zero parse errors. Validation
  (span ≥60%, ≥3 segments) passed first try.
- Tone sparse (2/56 tagged "laughing") — prompt needs stronger tone nudge if tone matters.
- Cost extrapolation: 32min ≈ 107k tokens/chunk-set. Flash = cheap. Use flash for
  transcribe, pro only for hard chunks.

### Model list confirmed (gemini key)
- Stable: gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite
- Previews: gemini-3-pro-preview, gemini-3-flash-preview, gemini-3.1-pro-preview, gemini-3.5-flash
- Embeddings: gemini-embedding-2 (for H3 alignment fallback if needed)
- Both GOOGLE_API_KEY + GEMINI_API_KEY set; pass apiKey explicitly to avoid the warning.

### H2 VERIFIED ✅ — AssemblyAI timestamped (Universal-2, whole 32min file)
- **34.8s** total (upload + transcribe). 47 utterances, 5874 words, **5 speakers**.
- **Word-accurate timestamps**: first utterance 00:00:00.160 → 00:00:02.960 = matches
  reference SRT exactly (0.160). speaker_B = presenter (81% talk time).
- audio_duration is in SECONDS (not ms) — fixed mapping (don't /1000).
- Caching by content-hash → re-runs instant. Use as primary timestamped provider.
- 5 speakers (A–E) = audience questioners separated too. Good for consistency bridge.

### H3 VERIFIED ✅ — alignment (flat edit-distance DP, ts-aligner approach)
- **KEY DESIGN LESSON:** per-segment windowed alignment DRIFTS. Cause: with fuzzy
  matches costing 0 (same as exact), the DP is indifferent to WHERE a common word
  ("it"/"the"/"as") matches; ties let it match a LATER similar word ("it"→"is"),
  over-advancing the pointer → cascading drift (median error 41s). Time-gating the
  window helped short segments but didn't fix the root cause.
- **FIX (works great):** align the ENTIRE chunk's LLM token stream (all segments
  concatenated, in order) against the ASR word stream in ONE edit-distance DP, then
  split back into segments. Long ordered sequences pin common words unambiguously.
  Costs ×2 integer: exact=0, fuzzy=1, sub=2, indel=2 (exact strictly preferred).
- **Result:** 54/56 aligned, median confidence **1.00**, coarse→aligned start delta
  **median 0.36s, max 0.99s**. Aligned times match reference SRT to the millisecond
  (seg2→0:05.440, seg4→0:14.400 = EXACT ref matches). 9 unit tests pass.
- DP size: flat_tokens × asr_words. 560×988 trivial. 32min full-file ≈ 3k×5.9k=17M
  cells (~seconds, ~70MB). Per-chunk in pipeline is smaller. Chunk for >2hr files.
- The "nearest-ref gap" metric in align-test is misleading (ref has 7 entries vs 56
  LLM segs) — need a text-matched eval scorer (build next).

### Remaining build-order items
- H4 consistency: bridge LLM per-chunk speaker labels ↔ ASR speakers (overlap vote).
- H5 identify: DeepSeek text pass to name speakers from content.
- finalize: overlap fix (ipgu-style + final re-check), clamp, SRT/MD/JSON, SRT-breaking.
- eval scorer: text-matched WER + timing error + speaker-label agreement vs reference.
- pipeline orchestrator: wire stages, concurrency, intermediates, resume.

### 🎉 END-TO-END VERIFIED — full pipeline on test-files/1 (32min talk + Q&A)
Pipeline: preprocess → describe → 4-chunk Gemini transcribe (concurrent) →
AssemblyAI → align → consistency → finalize → SRT/MD/JSON. ~3.5min wall clock.

**Stats:** 326 LLM segments → 326/326 aligned w/ ASR timing (1.6s DP, avg conf 0.80,
281 aligned + 45 interpolated) → 306 final segments after dedup.

**Quality (eval vs hand-checked reference SRT, 38 entries):**
- **WER 0.135 (86.5% word accuracy)** — strong for a noisy talk w/ interruptions/fillers.
- **Reference coverage 38/38** (every ref entry has overlapping output).
- **Boundary timing: median 0.00s, p90 2.16s** — segment boundaries align w/ reference.
- **Speaker accuracy 94%** after merging.

**H4 VERIFIED ✅ — consistency + merging.** AssemblyAI over-split the presenter into
speaker_A (62s) + speaker_B (1464s); the LLM labeled both "Presenter (Rishi)". The
consistency pass now MERGES ASR speakers sharing a SPECIFIC LLM label (not generic
"Speaker X") → presenter correctly unified. Generic-label speakers stay separate
(level-2 consistent). Global ids "Speaker A/B/…" by talk time.

**Eval lesson:** per-segment text-Jaccard was the wrong metric (granularity mismatch:
306 short output vs 38 long ref blocks; generic "Right." matched wrong entries →
bogus 721s p90). Switched to: full-transcript WER (word streams via edit-distance),
time-overlap reference coverage, boundary timing, time-overlap speaker agreement.
These are fair and stable.

**Minor issues to revisit:**
- First word "GPU" (ref 0:00:00.160) dropped — LLM didn't emit it as a separate seg
  in the full run (non-determinism). Could nudge prompt to not drop short openers.
- Tiny trailing SRT blocks ("get it." 0.4s) from LLM over-splitting — merge sub-MIN_DUR
  trailing blocks into the previous.
- Identify pass (H5, level 3) built but not yet wired into pipeline. The LLM already
  surfaces "Presenter (Rishi)" via self-ID; a DeepSeek pass would refine to "Hrishi".

### H5 VERIFIED ✅ — identify pass (DeepSeek, level 3)
- Wired into pipeline between consistency and finalize (runs when level >= 3 + DEEPSEEK_API_KEY).
- DeepSeek reads top-6 longest segments per speaker + roster, names via content cues.
- On test file: identified "Speaker A" → "Rishi" (presenter, from "my name is Rishi").
  Audience members left unnamed (no cues) → stay "Speaker B/C/D" (correct).
- Bug fixed: prompt must use the EXACT speaker id strings ("Speaker A"), not a
  hardcoded "speaker_A" example, or DeepSeek returns the wrong key and nothing renames.
- All 3 diarization levels now work: separation (ASR) → consistent (merged) → identified (named).

### Minor quality items (deferred / noted)
- "GPU" opening fragment sometimes dropped (LLM non-determinism) — could nudge prompt.
- Tiny trailing SRT blocks ("get it." 0.4s) — could merge sub-MIN_DUR trailing blocks.
- Tone tags sparse in full run (better in 5-min test) — prompt nudge or post-pass.

### Code review (fresh-eyes subagent) — fixes applied
Subagent review found real bugs; fixed:
- consistency: zero-overlap segments fell back to utterances[0] (wrong speaker) → now nearest
  utterance by time. groupTalk used segment COUNT not DURATION → A/B/C ordering was wrong →
  now uses talk duration. Both verified by new unit tests.
- aligner: timeMarginSec gate had asymmetric -1/+60 magic → symmetric w.end>=lo && w.start<=hi.
  Interpolation runLen crossed segment boundaries → bounded to same segIdx.
- finalize: fixOverlaps shift-next branch could unsort the array → guarded against overtaking
  the following segment.
- previousTail under concurrency: best-effort by design (reads prior chunk's cache; effective
  on resume or concurrency=1). The ASR backbone + label merging handle cross-chunk consistency
  regardless — documented.
Result after fixes: WER 0.135, speaker accuracy 94%→97%, 1 named presenter (Rishi) + 4 audience
questioners, clean output.

### Generalization verified — test-files/2 (Satya Nadella podcast, 41min, no reference)
Ran the full default pipeline on a completely different file (podcast, 3 speakers).
- 201/201 segments aligned with ASR timing; 189 final segments.
- Diarized 3 speakers correctly: **Speaker A = "Satya Nadella" (1962s)**, Speaker B =
  "Host (Female)" (312s), Speaker C = "Host (Male)" (128s). The identify pass named the
  guest AND role-labeled the hosts. SRT reads cleanly ("Host (Female): Please welcome...
  Satya Nadella"). System generalizes (talk→podcast, 2→3 speakers, named ID).

### Finalize merge — tried & reverted
Added mergeShortAdjacent (merge tiny same-speaker adjacent blocks for readability). It
REGRESSED WER 0.135→0.160 and inflated word count: adjacent segments share boundary words
(e.g. "...get it" / "get it. So by the way"), and concatenating duplicates them. A
text-similarity guard (skip high-sim) didn't fully fix it because shared-boundary segments
have LOW overall similarity yet share a phrase. Reverted — the tiny-block cosmetic issue
isn't worth a WER regression. (If revisited: merge on WORD-level dedup, not text concat.)

### Final state (test-files/1)
WER 0.135 (86.5%) · coverage 38/38 · boundary median 0.00s p90 2.16s · speaker 97% ·
1 named presenter (Rishi) + 4 audience questioners. 20 unit tests pass. typecheck + lint
(0 errors) + build (node + browser) green.

### Groq Whisper fallback provider (whisper-groq) — wired
- Free/fast timestamped fallback when AssemblyAI is unavailable. Groq's /audio/
  transcriptions (whisper-large-v3-turbo) returns word timestamps (no diarization).
  25MB limit → pipeline extracts a 64k mono mp3 for it.
- Consistency has a `hasDiarization` flag: when false (Whisper), groups by LLM label
  directly (no ASR backbone). Identify still works (named "Rishi" from LLM content).
- test-files/1 via Groq: WER 0.132 (86.8%), boundary median 0.26s p90 2.47s, speaker 93%.
  More speaker fragmentation (9 vs 5) without ASR diarization — AssemblyAI stays default.
- BUG FIXED: resolveOptions return object omitted `model`/`reasoner`/`timestampedProvider`
  (they were in the type but undefined at runtime) → --model/--reasoner/--timestamped were
  silently ignored. Now flow through. (Earlier runs used defaults so it was masked.)

### Finishing pass — complete
- Gap-fill: recovers dropped content (e.g. "GPU" opener at 00:00:00.160). 3 tests.
- Groq Whisper fallback (--timestamped whisper-groq): word timestamps, no diarization;
  consistency falls back to LLM-label grouping. WER 0.132 on test-files/1 (comparable).
- Tone: prompt nudge → 70% coverage (was ~4%); informative/joking/questioning/sarcastic.
- BUG FIX: resolveOptions now returns model/reasoner/timestampedProvider (were undefined).
- Lint: 0 errors (16 pragmatic `any` in provider interop). 27 tests. Zero-duration speaker
  artifacts filtered.

### Final fresh run (test-files/1, level 3, all finishing-pass changes)
WER 0.146 (85.4%) · coverage 38/38 · boundary timing median 0.00s p90 0.68s · speaker 96%
· tone 70% · "GPU" recovered · 1 presenter (Presenter (Hrishi)) + 4 audience.
(WER 0.136→0.146 vs the earlier cached run is within LLM run-to-run variance; boundary
timing improved p90 2.16s→0.68s.)

### Tested on ~/Downloads/a4/p.m4a (51min audio-only interview, user-provided)
- 6 chunks → 844 LLM segs → 844/844 aligned → 768 final. AssemblyAI: 2 speakers, 9564 words.
- Clean 2-speaker diarization (A: 1454s, B: 1321s — balanced interview). 98% tone coverage.
- Full duration coverage (1.4→3067s of 3071s). 90% aligned timing.
- Identify (DeepSeek) correctly inferred "CTO role" (Speaker B) + "female voice" (Speaker A)
  from content but honestly left names empty (no self-introductions) — correct level-3 fallback.
- BUG FIXED: --level 3 didn't auto-include the identify pass (DEFAULT_PASSES lacks it), so
  --level 3 alone silently produced level-2 output. resolveOptions now adds "identify" before
  "finalize" when level >= 3. (test-files/1 earlier only worked because --passes included it.)
