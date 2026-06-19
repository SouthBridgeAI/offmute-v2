# Review Fixes — human-review (review-1)

This document works through every problem raised in `docs/review-1/human-review.md` (the
verbal review of running the GLM build on `~/Desktop/VMeeting.mp4`). For each issue:

1. **Notes** — your verbal notes, rewritten/condensed.
2. **The error itself** — what actually happened on disk/screen.
3. **Diagnosis** — how the bug arose and why it was introduced (the "dx").
4. **Fix** — what I changed.

All fixes are committed; verification is at the bottom.

---

## Issue 1 — A new input file reused a previous file's transcript (the "Satya Nadella" / "ran too fast" / "cache hit" bug)

### Notes
> "It ran a little too fast. Like really fast. … It seems to have written the Satya Nadella
> transcript in there. 'cache hit' — cached, cached, cached, cached. … That is a bug. We hit
> some sort of stupid cache for one of the previously processed ones. So that is very much a
> bug that needs to be solved."

### The error itself
You ran:
```
node dist/cli.js -o ~/Desktop/offmute-glm/vmeeting-defaults ~/Desktop/VMeeting.mp4
```
The run finished almost instantly with every chunk reporting `cached`, the description was
the *Satya* recording's ("a segment of a live event or podcast interview"), and the output
`vmeeting-defaults/` contained the **Satya Nadella** transcript — not VMeeting. The log:
```
chunk 0: cached (37 segments)   chunk 1: cached (12) … chunk 4: cached (26)
[assemblyai] uploading ./intermediates/audio.flac …   done: 78 utterances, 3137 words, 2 speakers
outputs written to …/vmeeting-defaults
```
VMeeting was never actually transcribed. Every stage served a cached result that belonged to
a different file.

### Diagnosis — how this happened and why it was introduced
The CLI's `-i/--intermediates` option defaulted to a single shared directory, `./intermediates`
(`src/cli.ts`). The pipeline stores every stage's output under that one dir at fixed paths —
`audio.flac`, `probe.json`, `description.json`, `llm/chunk_NN_parsed.json`, `timestamped.json`
— and each stage's resume logic is just `if (existsSync(path)) reuse it`. **Nothing tied a
cached artifact to the input file it came from.**

So when you ran VMeeting without `-i`, it reused `./intermediates` from the previous run
(Satya): the existing `audio.flac` (Satya's) was not re-extracted, `probe.json` (Satya's
duration/chunk-plan) was reused, the LLM chunks were `cached` (Satya's), and AssemblyAI's
cache is keyed on a hash of `audio.flac` — which was still Satya's file, so it was a cache
hit too. End to end, VMeeting produced Satya's transcript. "Too fast" because zero real work
happened.

Why I introduced it: I built the caching for fast iteration while developing, and in my own
testing I *always* passed `-i intermediates/runN` (a fresh, manually-scoped dir per run), so
I never hit the collision. I never tested the **default** `-i` against two different files,
and I never added any input-identity check to the cache. The default-`./intermediates` path
was a footgun I left for the real user.

### Fix
Two layers, so the cache can never serve the wrong file again:

1. **Per-input intermediates dir by default.** `-i` is no longer a hardcoded `./intermediates`.
   If you don't pass it, `resolveOptions` derives `./intermediates/<inputBasename>-<hash(absPath)>`
   (`deriveIntermediatesDir` in `src/core/config.ts`). Different files → different dirs → no
   collision. `-i` still overrides for when you want a specific location.
2. **Input-identity manifest.** At pipeline start we compute a signature of the input
   (absolute path + size + mtime — cheap, no hashing multi-GB files) and store it in
   `<intermediates>/source.json`. On every run we compare; if the signature changed (or the
   manifest is absent), we set `forceAll = true`, which discards **all** cached intermediates
   for that dir and re-runs every stage. So even if you reuse a dir (or replace a file at the
   same path), stale caches are invalidated automatically.

Result: VMeeting now gets its own dir and is transcribed for real; the "Satya transcript"
outcome is impossible.

---

## Issue 2 — `--force` did not bust the cache (still got Satya's description)

### Notes
> "What happens if you do a force? That is a bug. … Even when I say force to bust the cache,
> we get to the description and that description goes [Satya's]."

### The error itself
Running with `--force` still produced Satya's description and transcript. `--force` appeared
to do nothing useful.

### Diagnosis — how this happened and why it was introduced
`--force` was applied **inconsistently** across the cache guards. Some checks had
`|| options.force` and some didn't:

| Artifact | Guard before fix | Honored `--force`? |
|---|---|---|
| `audio.flac` | `!existsSync \|\| options.force` | yes |
| keyframes | `!existsSync \|\| options.force` | yes |
| `description.json` | `options.force ? null : readJson` | yes |
| `llm/chunk_NN_parsed.json` | `options.force ? null : readJson` | yes |
| **`probe.json`** | `readJson(path) ?? probe(input)` | **no** — `??` only falls through when the file is *missing*; with Satya's `probe.json` present, it was reused, so the duration/chunk-plan stayed Satya's |
| **`sample.flac`** (describe input) | `if (!existsSync)` | **no** — Satya's sample was reused, so even a re-run of describe listened to Satya's audio → Satya's description |
| **`chunk_NN.flac`** (per-chunk audio) | `if (!existsSync)` | **no** — chunks re-transcribed but from Satya's chunk audio |

So `--force` re-extracted the *master* `audio.flac` (from VMeeting) but then reused Satya's
`probe.json`, Satya's `sample.flac`, and Satya's `chunk_NN.flac`. The freshly-extracted master
audio was never actually fed downstream. Net effect: still Satya.

Why I introduced it: the `existsSync` guards were added one at a time as I built each stage.
The "big" outputs (master audio, the JSON results) got `|| force`; the *inputs* to sub-steps
(the probe, the describe sample, the per-chunk audio slices) got plain `!existsSync` because
I thought of them as "already extracted, no need to redo." I never reconciled the two styles,
so `--force` was a leaky abstraction.

### Fix
Replaced the ad-hoc per-site `options.force` with a single `forceAll = options.force ||
inputChanged` (see Issue 1) and applied it to **every** cache guard uniformly — including
`probe.json`, `sample.flac`, and `chunk_NN.flac`, plus the derived caches
(`aligned.json`/`consistent.json`/`final.json`/`timestamped.json`) whose load-branches now do
`forceAll ? null : readJson(...)`. `--force` now reliably re-runs everything; and the
input-change check makes "force" automatic when the file changes.

---

## Issue 3 — Intermediates felt "hardcoded" to `./intermediates` and weren't where expected

### Notes
> "We seem to have hard coded like ./intermediates into a bunch of different places. So worth
> looking at, okay? Really worth looking at. … until that gets fixed, I'm not sure we can do
> anything else. … we don't have an intermediate folder [where I expected]."

### The error itself
The logs printed paths like `uploading ./intermediates/audio.flac`, and you couldn't find an
intermediates folder alongside the output. It looked like `./intermediates` was baked in
everywhere and shared by every run.

### Diagnosis — how this happened and why it was introduced
Not literally hardcoded in the pipeline — the pipeline uses `options.intermediatesDir`
throughout. But the **default value** of that option was the string `"./intermediates"`
(set in `src/cli.ts`), so unless you passed `-i`, *everything* landed in `./intermediates`
relative to the current working directory — shared across all runs and unrelated to the
output dir. The `./intermediates/...` strings you saw in the logs were just
`options.intermediatesDir + "/audio.flac"` with that default. (The one-off `scripts/*.ts`
helper scripts do hardcode `./intermediates/...`, but those aren't what the CLI runs.)

Why I introduced it: a fixed default is convenient for development (you always know where
intermediates are), and the `scripts/` pre-built test scripts each used their own
`./intermediates/<name>` subdir. I never made the *production* default input-aware, so to a
real user it behaved like a hardcoded, shared dump.

### Fix
The default is now **derived per input** (Issue 1's `deriveIntermediatesDir`), so each file
gets `./intermediates/<basename>-<hash>` automatically — no more shared dumping ground, and
the path is stable/predictable per file. `-i` still lets you place it explicitly (e.g. next to
the output). The CLI help text now says the default is auto-derived.

---

## Issue 4 — No upfront validation; "gets really far and then dies" / "a nice check to have at the beginning"

### Notes
> "It gets really far, same as the other version, gets really, really far and then dies if
> that directory doesn't exist. That would have been a nice check to have at the beginning. …
> a DX failure, I think, because I would expect to just run node cli <meeting> <output> and
> it should just work."

### The error itself
With a bad input path (or a missing output parent), the tool would proceed through stages and
only fail late — e.g. an absent input file wouldn't be caught until ffmpeg tried to open it
mid-pipeline, producing an opaque ffmpeg error instead of a clear upfront message.

### Diagnosis — how this happened and why it was introduced
The pipeline created the output and intermediates directories up front (`mkdirSync(...,
{recursive:true})`), so a missing *output* dir is actually handled — but there was **no
`existsSync(options.input)` check anywhere**. A missing or wrong input path sailed past
config resolution and only blew up when `probe()`/`extractAudio()` invoked ffmpeg on a
non-existent file, deep in the preprocess stage. "Nice check at the beginning" is exactly
what was missing.

Why I introduced it: during development my inputs always existed (I controlled them), so the
missing-input path never surfaced as a problem worth guarding. I optimized for the happy path
and skipped the obvious input-existence precondition.

### Fix
Added an early validation block at the very top of `transcribe()` (after resolving options,
before any work):
```
if (!existsSync(options.input)) throw new Error(`Input file not found: ${options.input}`);
mkdirSync(options.intermediatesDir, { recursive: true });
mkdirSync(options.outputDir, { recursive: true });
```
A missing input now fails immediately with `Fatal: Error: Input file not found: …`, and both
working dirs are guaranteed to exist before any stage runs — so the tool can't "get really far
and then die" on a missing input or directory. Combined with the per-input intermediates
default (Issue 1), `node cli <input> -o <out>` now "just works."

---

## Verification

Reproduced the original failure mode and confirmed each fix, using two short slices from
different sources (`sliceA`, `sliceB`) and the default (no `-i`):

| Check | Result |
|---|---|
| Two different files, default `-i` | separate dirs (`sliceA-d08f23ff`, `sliceB-928561f7`); probe durations differ (6s vs 9s) — **no collision** |
| Re-run same file | cache hit (no re-extract) |
| Replace file at same path (different size/mtime) | `WARN input file changed … discarding cached intermediates` → re-probed to new duration — **auto-invalidation** |
| `--force` on unchanged file | re-extracts (manual override) |
| Missing input | `Fatal: Error: Input file not found: …` — early, clear (not a late ffmpeg death) |
| Full default pipeline (no `-i`) on a 30s clip | real transcript of *that* clip (`GPU and I'm inspired…`), not a cached other-file transcript |

Green: `tsc --noEmit` clean, 27 unit tests pass, `tsup` build succeeds (node + browser).

## Files changed
- `src/core/config.ts` — `intermediatesDir` now optional; `deriveIntermediatesDir` + `inputSignature` helpers; `resolveOptions` derives the default.
- `src/cli.ts` — `-i` no longer has a hardcoded `"./intermediates"` default (derived instead); help text updated.
- `src/core/pipeline.ts` — early input-exists check; `source.json` manifest → `forceAll`; `forceAll` applied to every cache guard (probe, audio, keyframes, sample, chunk audio, description, llm, and derived aligned/consistent/final/timestamped).

## Things this did *not* change (intentional)
- The cache itself is still a feature (fast resume / iteration). The fix makes it **correct** (scoped per input + invalidated on change), not removed.
- `--force` still exists as a manual "redo everything" switch; it now actually works.
- `-i` is still honored when you want a specific intermediates location.
