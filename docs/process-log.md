<!-- Snapshot of the append-only development journal. The live working copy
     lives at ../intermediates/process_log_thoughts_ideas_hypotheses_and_scratch_space.md -->

# offmute-v2 — Process Log (append-only)

> Append-only scratch space. Newest entries at the bottom. Timestamps are real-world dates.
> Re-read this + README when context compresses.

---

## 2026-06-17 — Entry 1: Environment + study of the three inspirations

### Environment
- Workdir: `offmute-v2-opus` (I'm the "opus" variant; siblings `offmute-v2-glm`, `template` are parallel attempts — IGNORE them, work only in mine).
- Build target: `./offmute-v2/` (empty). Process log + my scratch: `./intermediates/`.
- Tools: node 20.11, npm 10, **bun 1.3.8**, **ffmpeg/ffprobe 8.0.1** (videotoolbox/audiotoolbox HW accel, libopus, libmp3lame, libx264/5), docker (orbstack), python3.9.
- Keys present: ANTHROPIC, ASSEMBLYAI, DEEPSEEK, GEMINI, GOOGLE, GROQ, OPENAI, GLM/ZAI/KIMI, EXA, FIRECRAWL.

### Test files
- `test-files/1/talk-with-questions.mov` — **9.6 GB**. h264 1920x1080@50fps, **PCM s24le 48kHz stereo** (uncompressed audio = why it's huge), duration **1913.52s (31.9 min)**.
  - `talk-with-questions.srt` — **GROUND TRUTH**, hand-checked. 38 cues, 2 named speakers (**Hrishi**/Rishi + **Audience**). Broken on **speaker turns** (NOT subtitle-sized): cue 7 is an 11.5-min monologue. So it's a *diarized transcript* reference, not display subs. Millisecond timestamps. Gaps between cues (applause/silence).
  - Content: a talk on building reliable AI agents ("don't leave Greenfield", CIA sabotage manual analogy) + Q&A.
- `test-files/2/...Satya-Nadella...NoPriors....mp4` — 702 MB, 1080p. No ground truth. Secondary test (2 clean speakers, podcast).

### offmute (the daily workhorse — Gemini multimodal)
Pipeline: **Describe → Transcribe → Report(spreadfill)**.
- **Describe** (`describe.ts`): parallel [screenshots→IMAGE_DESC] + [audio "tag sample" first 20min→AUDIO_DESC], then MERGE_DESC into one meeting description. This is the global CONTEXT (who's present, topics) fed to every transcription chunk.
- **Transcribe** (`transcribe.ts`): chunks processed **sequentially**. Each chunk gets: global description + **previous chunk's last 20 lines** (text only) + audio. Output format `~[Speaker Name]~: text` with tone annotations `(hesitant, etc)`. temp 0.2. Saves per-chunk progress JSON. Cleans `~[` → `\n\n~[`.
- **Chunking** (`audio-chunk.ts`): 10-min chunks, **1-min overlap**, mp3 44.1kHz/192k stereo. `totalChunks=ceil(dur/(chunkDur-overlap))`.
- Prompts (`prompts.ts`): notable rule — "Do NOT guess meeting time/date/metadata". Report uses **Spreadfill**: gen headings (JSON schema) → fill each section independently w/ full context → combine.
- Uses **deprecated** `@google/generative-ai` SDK (FileManager upload→poll→generate→delete). maxOutputTokens 65536 for 2.5+.
- **WEAKNESS = the v2 gap**: NO timestamps at all. The 1-min audio overlap has **no alignment/dedup** — relies on "continue where you left off" text instruction. Fragile across chunks.
- Models now (git log shows active upgrades): `gemini-2.5-{pro,flash,flash-lite}`, **`gemini-3-pro-preview`, `gemini-3-flash-preview`, `gemini-3.1-pro-preview`**. => Model world is AHEAD of my Jan-2026 cutoff. MUST verify live.

### ipgu (timestamp + XML + chunk-merge discipline — transcribe→translate→bilingual SRT)
Pipeline: **Split → Transcribe → Translate → Parse/Validate → Finalize**.
- **Split**: chunks by duration+overlap (default **20min/5min**!). Also splits reference SRT into matching chunks. ffmpeg via raw `spawn` (`-ss` after `-i`, accurate seek): mp3 44.1k/192k OR mp4 scale 640:360 crf28. Queue-based concurrency, skip-if-exists+!force.
- **Transcribe** (`gemini_transcriber.ts`): uses **NEW `@google/genai` SDK** (`ai.files.upload`, `ai.models.generateContentStream`). Prompt literally says *"Don't worry about getting the timestamps correct"*, format `relative (mm:ss - mm:ss) - (line)`. => They KNOW LLM timestamps drift; mm:ss = 1s granularity (coarse).
- **Validate** (`transcript_utils.ts`): parse `mm:ss - mm:ss` ranges; require ≥5 ranges; **LLM span must be ≥75% of chunk duration**; if reference SRT present, LLM span must be within ratio of ref span. Retry on fail. This catches "LLM gave up early / compressed time".
- **Adjust**: relative + chunkStartOffset = absolute. Simple add. `secondsToTimestamp`/`timestampToSeconds` utils (handle , and . decimal).
- **Finalize** (`finalizer/index.ts`): KEY merge logic —
  - Overlap dedup: keyed by originalId, **keep entry from the LATER chunk** (`sourceChunk >= existing`).
  - `fixAndClampTimings`: sort by start; iterative passes shorten earlier.end to next.start − 50ms gap; clamp duration **MIN 0.5s / MAX 7s** (subtitle constraints); multi-pass w/ MAX_PASSES=10 safety.
  - Option `useResponseTimings` (LLM) vs anchor to reference SRT timings. <-- the core tension.
- Robust LLM-output parsing was painful (git log: many "parser" + "Improving parser" commits). `ParsedTranslationEntry.sourceFormat: markdown|direct_tag|regex|unknown` => **multi-strategy parse w/ fallbacks** is the lesson.

### meeting-diary (real ASR timestamps + diarization — AssemblyAI)
- `processAudioFile`: AssemblyAI `transcripts.create({speaker_labels:true, speakers_expected})`. Returns **`utterances`** with `{speaker:'A'|'B', text, start, end (ms), confidence}`. Accurate word/utterance timings + consistent anonymous speaker labels (= **diarization level 2**).
- **Caching by sha256 file hash** → {audioUrl, transcriptId, transcript}. Great resumability pattern.
- Speaker ID (level 3): **interactive** — `identifySpeakers` shows `findBestExamplesForSpeaker` (longest segments per speaker as representative samples) + neighbor context, asks human "Who is this?". 
- Outputs: SRT (`speaker: text`), text (`[speaker] text`), markdown (`[time] **speaker**: text`).
- WEAKNESS: anonymous speakers need human for names; no multimodal/tone; single model.

---

## SYNTHESIS — the v2 thesis

Each tool is best at ONE axis:
- **ASR (AssemblyAI/Deepgram/Whisper)** = best at **WHEN** (accurate word/utterance timestamps) + cheap baseline diarization (who-changed-when).
- **Multimodal LLM (Gemini)** = best at **WHO** (names from context, multimodal w/ video keyframes), **HOW** (tone/emotion), clean text, hard audio (crowds, interruptions, accents), cross-chunk reasoning.
- **ipgu's discipline** = chunk/overlap/merge/validate machinery + intermediates-on-disk + retries.

**Core hypothesis (to validate empirically):**
> Produce the high-quality diarized transcript with the LLM (names+tone+clean text, per chunk like offmute), and get accurate timestamps from an ASR "timing track" (word-level). Then **ALIGN** the LLM's turns/sentences to the ASR words via fuzzy sequence matching to assign correct start/end. This is "forced alignment" using an existing ASR transcript as the timing reference rather than an acoustic model.

Why LLM-primary + ASR-timing-anchor (not ASR-primary):
- The hard, valuable parts (named speakers, tone, fixing ASR errors, interruptions) are the LLM's strength.
- ASR text may be wrong/garbled but its *timestamps* are reliable. We borrow only the timing.
- Alignment must be robust to text mismatch (LLM "fixes" words) → token-level DP / normalized matching.

Risks / failure modes to watch:
1. **Alignment drift** when LLM text and ASR text diverge a lot (paraphrase, dropped filler). Detection: % of LLM tokens that matched an ASR anchor; flag low-confidence spans.
2. **Speaker mapping**: ASR's speaker A/B ≠ LLM's "Hrishi/Audience". Need to reconcile (LLM names ↔ ASR turns). Could let LLM read ASR's diarized+timed transcript and just RELABEL/identify, keeping ASR's turn boundaries+timings. (Alternative architecture — maybe simpler & more robust! "ASR for structure+time, LLM for identity+tone+corrections".)
3. **Chunk boundaries**: a speaker turn split across chunks. Overlap + dedup (ipgu pattern).
4. **Long monologue** (cue 7 = 11.5 min): ground truth keeps as one block; for display SRT must sub-split on sentence/pause without losing speaker.
5. **Coarse LLM timestamps**: don't trust them for final output; only for rough ordering/anchoring.

Two candidate architectures to A/B:
- **(A) LLM-primary + align to ASR words**: richest text, hardest alignment.
- **(B) ASR-primary (utterances+timings) + LLM relabels/enriches**: timestamps trivially correct (straight from ASR), LLM only assigns names + tone + fixes obvious text errors per utterance, keeping utterance boundaries. Much simpler alignment (1:1 per utterance). Risk: ASR diarization errors (wrong speaker turns, missed interruptions) propagate.
- Likely the **best = hybrid**: ASR gives word timings + candidate turns; LLM does diarization/identity/tone reading BOTH the audio (+keyframes) AND the ASR timed transcript as scaffold; then align LLM output to ASR word times. Start simple (B), measure, add (A) where B fails.

### Eval plan (must measure, not vibe)
Against `talk-with-questions.srt` ground truth:
- **WER** on text (normalized).
- **Diarization**: speaker-attributed WER / DER-ish; did we get 2 speakers, named correctly (Hrishi+Audience)?
- **Timestamp accuracy**: median/p90 boundary error (s) vs ground-truth cue boundaries (align by text).
- Read transcripts by eye (instructions stress this).

### Decisions / TODO seeds
- Use **new `@google/genai` SDK** (not deprecated one).
- ffmpeg via `spawn` (no fluent-ffmpeg dep; browser uses ffmpeg.wasm separately).
- Audio for ASR: 16kHz mono. For Gemini: 16kHz mono mp3/opus is fine and tiny (Gemini downsamples to 16k mono anyway, ~32 tokens/s).
- Save ALL intermediates (chunks, raw LLM, ASR json, aligned) to disk for debug + resume (hash-keyed like meeting-diary).
- Verify live model names + ASR options via web research + quick API pings BEFORE building.
- Open Q: which ASR? AssemblyAI (has diarization, proven) vs Deepgram (no key) vs Groq whisper-large-v3 (fast/cheap, NO diarization) vs Gemini-as-ASR. Test.

---

## 2026-06-17 — Entry 2: SOTA research + model landscape (live API + web)

### Live Gemini models (queried API, June 2026 — AHEAD of my Jan-2026 cutoff)
- 2.5: `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite` (1M in / 65k out)
- 3.x: `gemini-3-pro-preview`, `gemini-3-flash-preview`, `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite`, **`gemini-3.5-flash`** (newest GA), `gemini-3-pro-image`
- Aliases: `gemini-pro-latest`, `gemini-flash-latest`, `gemini-flash-lite-latest` (use these to stay current)
- All 1M input / 65k output. => **A 32-min talk's audio (~32 tok/s ⇒ ~60k tokens) fits in ONE context** with huge headroom. Output (full transcript ~7k tokens) << 65k. So single-pass whole-file LLM transcription is feasible for ≤~1hr. Chunk only for very long media or if quality degrades. Big simplification vs offmute (which chunked due to old small contexts).
  - CAVEAT: speaker in our own test file says models degrade past ~0.5–1MB of *actual data*; audio counts. Must test single-pass vs chunked for accuracy/skipping.

### ASR landscape (live API + web)
- **AssemblyAI** — Universal-2 (99 langs, $0.15/hr, **diarization free**) / Universal-3 Pro (6 langs, prompt-based). Word-level timestamps + confidence in JSON. Diarization strong: handles 250ms segments, +30% in noise, in-house models. **PROVEN (meeting-diary), has SDK. → primary ASR pick for precise timing + baseline diarization.** 32min ≈ $0.08.
- **OpenAI `gpt-4o-transcribe-diarize`** (NEW, post-cutoff) — built-in diarization, `diarized_json` = speaker labels (A:,B:) + segment start/end. Needs `chunking_strategy:"auto"` >30s. **Word-level timestamps unclear** (segment-level confirmed). No prompting on diarize variant. Some GitHub reliability issues. $0.006/min ($0.36/hr). → test as alt.
- **Groq `whisper-large-v3-turbo`** / `whisper-large-v3` — fast, cheap, word timestamps, **NO diarization**. → good as a cheap fast timing track if pairing with separate diarization.
- **OpenAI**: also `gpt-audio-1.5`, `gpt-realtime-whisper`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`.
- **Gemini as ASR**: "best-in-class diarization" (marketing); timestamps **MM:SS = 1s granularity, coarse/drifty** (confirmed by ipgu experience + current docs). Good for CONTENT (who/tone/text), NOT precise timing. Stereo-channel hint trick ("left=interviewer, right=guest") boosts diarization.

### Architecture decision (refined)
**Primary = ASR-anchored (architecture B), with LLM enrichment:**
1. **AssemblyAI** → utterances {speaker A/B/C, text, start/end ms, word-level} = TIMING + baseline diarization scaffold.
2. **Gemini (3.x multimodal)** reads audio (+ keyframes) + the AssemblyAI timed transcript, and: (a) assigns **real names** to A/B/C (from context), (b) adds **tone**, (c) **fixes ASR text errors**, (d) flags/【corrects diarization mistakes】, (e) maps raw clusters → **semantic roles**.
3. **Align** Gemini's output back onto AssemblyAI's word timestamps (easy when Gemini edits a structure that already has IDs+times; harder if it re-segments — keep word anchors).
- Easier alignment than architecture A (LLM free-form text → ASR words). Start with B, measure vs ground truth, add A's fuzzy-DP alignment only where B fails.

### KEY INSIGHT from ground truth: diarization ≠ "separate every voice"
Our ground truth lumps ALL audience members as **"Audience"** (by ROLE), and the main speaker as "Hrishi". Raw ASR diarization would split audience into A/B/C/D by voice. => The system must let the **LLM map voice-clusters → semantic labels per user intent/instructions** ("one main speaker, everyone else = Audience"). This is exactly where LLM-layer understanding beats pure ASR. Instructions matter. offmute-style "main speaker is X" guidance handles it.

### Cost sanity (32-min file)
- AssemblyAI: ~$0.08. Gemini 3 flash/pro single-pass: input ~60k audio tok + a few k text; output ~7k. Cheap (cents to low-$). Whole pipeline likely <$0.20/file on flash, <$1 on pro.

### Next: EMPIRICAL validation before building the full pipeline
1. Preprocess: extract 16k mono audio from the .mov; make a short clip (e.g. 0–3min and a Q&A section) for fast iteration.
2. Run AssemblyAI on clip → inspect word timestamps + diarization JSON shape + quality.
3. Run Gemini (flash + pro) on clip → inspect diarization/timestamp/tone quality + format adherence.
4. Compare both vs ground truth (the .srt). Decide chunk size, which models, single-pass vs chunked.

---

## 2026-06-17 — Entry 3: EMPIRICAL VALIDATION — architecture proven end-to-end

Ran all three stages on the real 32-min talk. Results strongly confirm the thesis.

### Stage findings
- **Preprocess**: ffmpeg w/ HW accel → 9.6GB .mov to 14.6MB 16k-mono mp3 in **2.9s**. Keyframes show speaker + slides ("How to *not* leave Greenfield", Munger + OSS sabotage manual) — multimodal context is rich & cheap.
- **AssemblyAI**: word-level timestamps **excellent** (sub-second, matches GT to the cs). Diarization: **collapsed to 1 speaker on the intro clip** (brief audience interjections merged into Hrishi); on Q&A clip found A/B/C with decent turns but lumps different audience members + boundary errors. Full file: 5852 words, 49 utterances, **5 speakers A–E** (audience split). => **ASR timing = gold; ASR diarization = unreliable on hard interjections.**
- **Gemini** (flash-latest): diarization **far better** — separated Hrishi vs audience AND inferred the name "Rishi" on the intro clip where ASR failed. Tone captured (laughing/enthusiastic/joking). Pro-latest marginally better tone + got "NUS" right (3x slower, 65s, 7718 thinking tok). **Timestamps coarse mm:ss, one per turn (11.5-min monologue = 1 timestamp), and DRIFT badly over long files: raw output ended [36:31] for a 31:53 file (+4.5min, ~14% accelerating drift).**
- **GOTCHA (logged)**: thinking models — `maxOutputTokens` caps thinking+output COMBINED. First full-file run: thoughts=15729 ate the 16384 budget → out=1 (empty). Fix: maxOutputTokens=65536 + bounded thinkingBudget (4096). Then full file: in=47996 out=10713 thoughts=11853, 110s, 6682 words, full coverage.

### Alignment layer (the crux) — WORKS
Needleman–Wunsch token alignment (LLM turns ↔ ASR words), read precise times off matched ASR words, interpolate gaps. 11ms for a clip.
- Intro clip: recovered turn starts 0:09 / 0:14 matching GT exactly; matchRatio (91/73/94%) = built-in confidence.
- **Full pipeline eval vs GT**: **WER 8.4%**, **word-level speaker accuracy 99.5%**, drift **erased** (last seg aligned to [31:50] not [36:31]). Timing median 1.35s / p90 7.97s — but that p90 is an **artifact** of linearly interpolating word times inside huge segments (the 10-min mono-turn) on BOTH ref and hyp; turn *boundaries* are accurate.
- **Our diarization sometimes beats GT**: at 13:07 GT merges Matthew's observation + Rishi's reply under "Hrishi"; our pipeline splits them correctly and even names "Matthew". => GT has merge errors; 99.5% is at GT's noise floor.

### Decisions locked
1. **Architecture = ASR(timing) + Gemini(diarization/names/tone/text) + token-alignment.** Validated.
2. Default LLM = `gemini-flash-latest` (fast/cheap/great); `gemini-pro-latest` as quality option/refinement.
3. Default ASR = AssemblyAI (word timestamps; keep its diarization only as a *hint*, not authority).
4. Single-pass works for ≤~32min with maxOut=65536 + bounded thinking; **chunk for longer** (overlap + alignment-merge). Need to test the >45min/2hr case.

### Refinements to build into the real pipeline
- **Sub-segment splitting**: don't keep 10-min mono-turns. Use per-LLM-token→ASR-word time map to cut turns into sentence/phrase/subtitle-sized cues with REAL word times (not interpolated). Fixes timing metric + makes display SRT. → refactor align to expose per-token times.
- **Speaker identification pass**: canonicalize Gemini's labels (Rishi→Hrishi, group audience per instructions). Multi-pass: a speaker may name themselves once.
- **Structured Gemini output** (JSON schema: turns[{speaker,tone,text,approxStart}]) for robust parsing (avoid regex brittleness; but keep lenient parser as fallback — ipgu lesson).
- **Drop no-word hallucinations** (the "(applause)" turns — already handled by matchedWords==0).
- **Caching/resume** by media hash (meeting-diary pattern) for each stage's intermediates.
- **Instructions plumbing**: user can say "one main speaker = Hrishi, rest = Audience" to drive semantic grouping.

### Eval caveat to remember
GT word-time is interpolated within long cues → timing metric noisy. For a truer timing metric, compare turn-BOUNDARY times for short cues only, or build a denser reference. Boundaries are the real signal.

---

## 2026-06-17 — Entry 4: Real pipeline built + the THINKING-LEVEL gotcha

Built the productized pipeline: `pipeline.ts` (probe→preprocess→ASR→diarize→align→identify→format), `cli.ts`, formatters (SRT/MD/JSON/text), `speakers.ts`, `identify.ts` (LLM speaker-merge), `node/intermediates.ts` (hash-keyed resume), `core/chunk.ts` (chunk calc + overlap merge). Unit tests (17) green. Typecheck/strict clean.

### 🔴 MAJOR GOTCHA: Gemini 3.x thinking control (cost me real debugging)
- `maxOutputTokens` caps **thinking + output COMBINED**. On the full 32-min file, thinking ballooned and ate the whole budget → **empty output**.
- **`thinkingBudget` is IGNORED by Gemini 3.x** (`gemini-flash-latest` = gemini-3.5-flash). It's a 2.5-only knob. Setting `thinkingBudget:4096` → model still used **62914** thinking tokens.
- Gemini 3.x uses **`thinkingConfig.thinkingLevel`**: `MINIMAL | LOW | MEDIUM | HIGH`.
- Empirical on full file (same prompt):
  - `LOW`   → thoughts=**62912**, out=**1** (empty), 251s ❌  (LOW still over-thinks long audio!)
  - `MINIMAL` → thoughts=0, out=**8493**, full 33530-char transcript, **48s** ✅
- **DECISION: default `thinkingLevel: "MINIMAL"` for diarization + identify.** Transcription is perception, not reasoning — thinking hurts (empty output, 5x slower). Also faster/cheaper. Provider supports both knobs (level preferred); exposed as `--thinking-level`.
- Lesson: when a model returns empty text, check `usageMetadata` for thoughts vs output tokens FIRST.

### Pipeline design notes
- **Speaker canonicalization is voice-anchored**: align each LLM turn-label's words to ASR words → `asrSpeakerByLabel` (label → ASR-voice distribution). Pass to the identify LLM as a STRONG merge hint. This also reconciles labels ACROSS chunks (whole-file ASR voices A/B/C are the global anchor).
- Identify uses lenient JSON-in-text parsing (not schema) — ipgu lesson. Falls back to raw labels on failure.
- Tone attached **once per turn** (first sub-segment only) — was repeating ~80× in merged markdown.
- Chunking: single-pass if ≤35min; else 15min/2min chunks. ASR is whole-file (cheap). Each chunk's turns align to ASR words in its window; `mergeChunkSegments` dedups overlaps (time-overlap>0.5 + text-Jaccard>0.4, keep higher matchRatio / more-internal). Single-pass goes through the same loop (1 chunk) → identical result.

### Known edge case (acceptable)
- Very first turn ("GPU and I'm inspired… apply to NTU… help me get it") is genuinely ambiguous (Hrishi joking vs audience). Gemini labels it provisionally; identify sometimes routes to Audience. Voice says it's Hrishi's voice (A=21, same as Rishi A=4810) but Matthew also shows A=34 (ASR error), so voice isn't decisive alone. Re-running diarization WITH instructions (telling it the presenter is Hrishi) is the proper fix — testing.

### Eval status (prev successful single-pass output, pre-MINIMAL)
WER 8.5%, speaker 98.8–99.5%, **boundary timing median 0.04–0.06s / p90 0.39–1.25s**. Production-grade.

---

## 2026-06-17 — Entry 5: Chunking validated + packaging

- **Fixed flow (MINIMAL thinking + instructions-in-diarization) single-pass**: WER **8.1%**, speaker **98.8%**, boundary median **0.04s** / p90 **0.43s**. First line now correctly "Hrishi" (instructions reached diarization).
- **Chunked path (forced 3×15min chunks on the 32min file)**: WER **8.4%**, speaker **99.0%**, boundary median **0.06s** / p90 **0.66s** — statistically identical to single-pass. Cross-chunk speaker identity holds (whole-file ASR voices = global anchor; identify merges per-chunk labels). `mergeChunkSegments` overlap-dedup works.
- DRY'd the post-LLM logic into pure `core/assemble.ts` (`alignTurnsToSegments` + `buildTranscript`), reused by node pipeline AND browser. No regression.
- **Build**: tsup → `dist/index.js` (node), `dist/cli.js` (shebang ok), `dist/browser.js` (**32KB, 0 node deps**) + `.d.ts`. CLI `--help` works.
- 17 unit tests green; strict typecheck clean.

### Status: core pipeline COMPLETE & validated (single + chunked). 
Remaining: generalization test on file 2 (Satya podcast, 2 clean speakers, no instructions); fresh-eyes code review; package.json polish; ffmpeg.wasm browser preprocess is left to the host (documented).

---

## 2026-06-17 — Entry 6: Generalization + retries + fresh-eyes review applied

### Generalization test (file 2: Satya Nadella No Priors podcast, 41min, UNSEEN)
Ran full default pipeline (chunked into 3, WITH video keyframes, **NO instructions**):
- **Identified all 5 speakers BY NAME from context alone**: Announcer, **Sarah Guo**, **Satya Nadella**, **Elad Gil**, **swix** — with correct roles (CEO, co-hosts/VCs). The announcer names them at the open; identify + voice anchoring resolved them across 3 chunks. Transcript reads cleanly.
- => Architecture generalizes: different format (podcast vs talk), more speakers (5 vs 2), auto-identification, chunked, video.

### Robustness: retries
- Hit a real transient **Gemini 503** mid-run → added `withRetry` (exp backoff + jitter, retries 503/429/5xx/network) around upload + generateContent. Cache/resume meant the re-run skipped ASR/audio. Worked.

### Fresh-eyes code review (subagent, empirically verified its findings; I rejected one)
Applied:
- **chunk overlap dedup**: only across DIFFERENT chunks (real overlap dups); label-INDEPENDENT (REJECTED the agent's "require same speaker" — cross-chunk labels intentionally differ before identify). Clamp overlap to [0,50% chunk] (prevents runaway chunk count / audio gaps from misconfig — agent repro'd 2701 chunks / silent gaps).
- **sub-segment gap split** only when BOTH tokens are real ASR matches (interpolated tokens are evenly spread → spurious splits). Real quality fix (affects every file).
- **keep substantial zero-match turns** (real ASR-missed speech) as low-confidence; only drop short word-less noise (applause). Re-eval: deletions 74→65 (better coverage), WER still 8.1%, boundary 0.04s. +14 segments recovered.
- chunked no-ASR: make approxStart absolute (was chunk-relative → scrambled order).
- srt: reject timecode/numeric speaker prefixes; scan all lines for timing. time: guard non-finite.
- identify: forbid "Mixed/Panel" catch-all speakers (was inventing one on the podcast → fixed to 5 clean speakers).
- GOTCHA: the review subagent wrote `_bug_probe*.test.ts` to the project root; my `git add -A` committed them. Cleaned + gitignored `_bug_probe*`/`_tmp*`/`scratch_*`.

### Known limitations (documented, acceptable for v1)
- Chunk overlap merge is heuristic (time+text Jaccard). The principled fix is ASR-word-INDEX dedup (thread global word index through). Empirically clean on the 32min 3-chunk test (WER 8.4%, identical to single-pass), so deferred.
- `assignTimings`/`interpolateTimings` in align.ts are superseded by the token-level path; still used by `scripts/test-align.ts`. Harmless; could remove.
- Browser: pure fusion core ships (32KB); media preprocessing (ffmpeg.wasm) + provider fetch are left to the host (documented in README/SPEC).

### Final metrics (talk-with-questions, ground truth)
single-pass: **WER 8.1%, speaker 98.7%, boundary median 0.04s / p90 0.43s**. chunked: WER 8.4%, speaker 99.0%, boundary 0.06s. 29 unit tests green; strict tsc clean; tsup builds node+browser.

---

## 2026-06-17 — Entry 7: Full in-browser path + finishing

### Browser now actually runs (not just docs)
- `core/retry.ts`: shared browser-safe retry (SDK provider imports it now too).
- `providers/gemini-fetch.ts`: isomorphic Gemini over fetch — Files API **resumable** upload (start→upload,finalize→poll ACTIVE) + generateContent REST. **Verified against the live API in node.**
- `providers/assemblyai-fetch.ts`: isomorphic AssemblyAI over fetch (upload→create→poll). **Verified live.**
- `media/ffmpeg-wasm.ts`: audio + keyframe extraction via an **injected** FFmpeg instance (no hard dep → stays out of the 49KB bundle).
- `browser-pipeline.ts`: `transcribeInBrowser(file, {ffmpeg, apiKeys, ...})` — full preprocess→ASR→diarize→align→merge→identify→format with chunking, mirroring node.
- `examples/browser/index.html`: runnable demo (ffmpeg.wasm single-thread core from CDN → no COOP/COEP needed).
- **VALIDATED end-to-end**: ran the REAL browser orchestrator in node via an `FFmpegLike` shim backed by native ffmpeg (only ffmpeg.wasm swapped). 51 segments, 2 speakers, correct timing (GPU@0.16→00:00:00,160). Browser bundle stays pure (0 node/SDK imports).
- package.json: `@ffmpeg/ffmpeg`/`@ffmpeg/util` as OPTIONAL peer deps (browser only).

### Loose ends
- Removed dead `assignTimings`/`interpolateTimings`/`SegmentToTime`/`TimedSegmentResult` (superseded by token path) + deleted `scripts/test-align.ts`.
- **Principled chunk dedup** = `chunkOwnership()`: partition the timeline at overlap MIDPOINTS; assign each segment to the chunk owning its center time → every word emitted once, no fuzzy dedup needed.
  - GOTCHA found while testing: ownership filtering CONFLICTED with the old "do NOT repeat the overlap" prompt → chunk i+1 skipped the overlap, ownership dropped chunk i's copy → CONTENT LOST (WER 8.4%→10.7%, deletions 80→245). Fix: changed the chunk prompt to "transcribe EVERYTHING in this clip in full (overlap included); the tail is continuity context only". Re-running fresh to validate. (If ownership+full-transcription doesn't beat the old fuzzy-dedup 8.4%, revert to fuzzy.)

### Ownership result: BEST yet
Fresh chunked run (ownership + full-transcription prompt): **WER 7.7%** (lowest — beats single-pass 8.1% and old fuzzy-chunked 8.4%), deletions 63 (vs 245 broken / 80 fuzzy), speaker 98.9%, boundary median 0.05s. Each word emitted exactly once. Kept ownership; `mergeChunkSegments` stays as a safety net. Principled fix validated & superior.

---

## 2026-06-19 — Entry 8: Review-1 fixes (human review caught 3 blockers)

User ran the BUILT `node dist/cli.js` on real files; found:
- **Blocker 1**: audio-only `.m4a` crashed on keyframe extraction. Root: CLI `--no-video` (commander) makes `opts.video=true`, so `useVideo = options.useVideo ?? isVideo` short-circuited true → tried keyframes on audio. Also no resilience. Fix: `&& info.hasVideo` + try/catch degrade. **Plus: dist was STALE** — I'd patched source last session but never rebuilt, so the user kept hitting it. Rebuilt + verified in dist.
- **Blockers 2 & 3**: `-m gemini-2.5-pro` and `-m gemini-3.1-pro-preview` both 400'd on thinking config. Root: I hardcoded `thinkingLevel: MINIMAL` (validated only on 3.x-flash) for ALL models. 2.5 needs `thinkingBudget`; 3.x-PRO rejects MINIMAL. Fix: `providers/thinking.ts` `resolveThinkingConfig(model, level)` (model-aware) + 400-fallback that drops thinking config. All 4 models verified live.
- **Bug 4**: intermediates landed next to INPUT regardless of `-o` (modeled on offmute, never reconciled with v2's `-o`). Fix: CLI defaults intermediates inside the output dir.
- **Bug 5**: output dir not created → would crash at the END after all work. Fix: mkdir up front (fail fast).
- **Nit 6**: progress timer didn't live-count. Fix: setInterval redraws stage line w/ live elapsed.
- **Doc 7**: align.ts comment claimed a "banded Needleman–Wunsch" that doesn't exist. Algo IS textbook NW (full O(n·m)); fixed the comment.
- **8**: "text not wired up" — investigated; surface text IS wired (tokenize→AlignedToken.surface→segment.text); alignment matches on normalized by design. No bug; likely the #7 comment.
- **9**: streaming/stop-path/batch — real feature gaps, documented, deferred.

**META-LESSON (the shared root cause of 1-3): I validated each mechanism on ONE config and generalized** (audio-through-CLI, non-flash models, missing output dir = untested second paths). Encoded the model×thinking matrix + edge cases in tests (34 green). And: ALWAYS rebuild dist when fixing — the user runs the built artifact.

Full diagnosis written to `docs/review-1/review-fixes.md` (notes + error + dy/dx + fix per item).
