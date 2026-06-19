# Comparison review — what I changed in the Opus build

Context: a head-to-head review of the GLM and Opus builds
(`../../review-comparison.md`). GLM was chosen as the primary `offmute-v2@latest`
(readability / conventions); this build ships as `offmute-v2@opus`. The review was
fair and detailed; this doc records what I implemented in response — and what I
deliberately didn't.

Most of the Opus "cons" were already closed in reviews 1–2 (audio-only keyframes,
model thinking-config, intermediates location, JSON-mode identify, stage-tagged
errors, always-valid SRT, AbortSignal, the NW comment, `aliases`→`resolvedNames`).
The items below are the ones the comparison left genuinely open.

## Implemented

### 1. Source-signature cache invalidation — the most important one

The review's headline finding was that **both** builds' worst bug lived in the
caching layer, and GLM's was *silent*: it served a previous file's transcript from
a stale cache. I checked whether my build shared that **class** — and it did:
`mediaKey()` was defined but **never used**, so my cache was gated only by
`existsSync`. A different file reusing the same intermediates dir, the same path
with changed content, or even a different model/instructions would have happily
served the prior run's result.

**Fix** (`pipeline.ts`): write a `source.json` signature — `mediaKey`
(path+size+mtime) plus the output-affecting config (model, instructions,
thinkingLevel, asr, subSegment, identify). If it doesn't match what's cached, the
cache is disabled for that run, so we never serve a stale/wrong transcript.
Correctness over speed; same-input+config re-runs still resume from cache.

**Verified:** two different files through one shared intermediates dir → the second
prints "input/config changed — ignoring stale cache" and returns *its own*
transcript, not the first's. Same-input re-run stays cached (0s). This closes the
exact silent-wrong-output class the review flagged as the scariest.

### 2. DRY the Node/browser orchestration — the biggest engineering criticism

The review called the ~80% identical chunk-loop/window/ownership/merge code across
`pipeline.ts` and `browser-pipeline.ts` "the most likely source of future
divergence."

**Fix:** extracted it into `core/orchestrate.ts` (browser-safe). `orchestrateChunks()`
owns chunking, prompt assembly, alignment, ownership partitioning, and the merge;
each pipeline injects only `diarizeChunk` (its media + LLM + caching) and an optional
`onChunk` (side effects). `sliceAsrWindow`/`mergeVoiceDist` moved there too. The two
pipelines now differ only where they genuinely must (ffmpeg spawn + SDK vs ffmpeg.wasm
+ fetch). **Verified no behavior change:** single-pass WER 8.1% / boundary 0.04s and
chunked WER 7.7% / boundary 0.05s are byte-for-byte unchanged.

### 3. Live partial output

Addresses the review-1/2 note that the output folder is "empty until the very end"
with "no stop path." The shared orchestrator's `onChunk` hook lets the Node pipeline
write a running `transcript.partial.srt` after each chunk (and `diarize.parsed.json`
per chunk). So you can watch progress mid-run and recover a partial transcript if a
long run is interrupted — alongside the `AbortSignal` added in review 2.

### 4. Spec-vs-implementation drift

- The CLI advertised a `text` format that wasn't wired → **wired** it (`toText` →
  `.txt`, `text` added to the pipeline result).
- Removed the dead `description`/"context describe pass" plumbing the review flagged
  as plumbed-but-never-produced. It would be redundant here: visual context is the
  **keyframes passed directly to every diarize call** (offmute needed a separate
  describe because it didn't do that).
- Corrected the SPEC: dropped the unimplemented `passes`/best-so-far claims (now an
  explicit "NOT implemented" list), fixed the browser entry (full ffmpeg.wasm
  pipeline shipped, ~49–52KB not 32KB), and updated the config surface to the real
  options.

## Already present (credited by the review — no action needed)

Ownership-partition chunk merge, voice-anchored identify hint, the real ffmpeg.wasm
browser pipeline + demo, always-valid-output property tests, stage-tagged errors,
JSON-mode identify, and graceful degradation are all in this build already (the
review lists several of these as "what to port from Opus into GLM").

## On the WER headline (Part 4) — agreed, no change

Part 4's re-score is fair: my raw WER edge (7.2% vs 15.0%) is **not** a ~2× quality
gap. About half of GLM's number was a fixable overlap-dedup bug, and the rest is
GLM keeping more verbatim disfluencies that the human reference cleaned out. On a
controlled comparison the engines are ~equal. My ownership-partition merge is why I
have few near-duplicates (6 vs 24), which is the correct behavior — nothing to
"fix" on my side here, but I'm not claiming a transcription-quality win.

## Deliberately NOT implemented (and why)

- **Multi-pass refinement loop (`passes`).** Single diarize + the voice-anchored
  identify pass already hits the measured accuracy; a refinement loop is more
  machinery and LLM spend than the numbers justify. Removed from the SPEC rather
  than left as a false promise.
- **Full "stop and emit best-so-far."** `AbortSignal` (throws) + the per-chunk
  `transcript.partial.srt` cover the practical need (cancel + recover a partial);
  a graceful stop-and-return-partial API is deferred.
- **Batch (multiple inputs per invocation).** Out of scope for the one-input CLI;
  noted as future.

## Process note

The review correctly observed that neither build used branches for risky work —
everything stayed on `master`. Fair. These comparison fixes were verified against
the eval harness before committing (the DRY refactor especially, since it touched
both validated pipelines), which is the safety net I leaned on instead.
