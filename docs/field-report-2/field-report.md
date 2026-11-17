# Field Report 2: 17 meetings, 12.4 hours, and Gemini 4

The maintainer's own November 2026 runs of `offmute-v2@0.1.1` on defaults (`gemini-3.1-pro-preview` +
AssemblyAI universal-2): 17 recordings, 9 minutes to 1h27m, two to five speakers, one in Korean. They're
referred to here as **M01–M17**; no participant's speech is quoted. Built on `fix/field-report-1`, whose fixes
are assumed throughout.

| code | length | code | length | code | length | code | length |
| ---- | ------ | ---- | ------ | ---- | ------ | ---- | ------ |
| M01  | 42 min | M06  | 28 min | M11  | 65 min | M16  | 65 min |
| M02  | 33 min | M07  | 59 min | M12  | 87 min | M17  | 23 min |
| M03  | 48 min | M08  | 26 min | M13  | 63 min |      |        |
| M04  | 34 min | M09  | 41 min | M14  | 32 min |      |        |
| M05  | 73 min | M10  | 16 min | M15  | 9 min (Korean) | |   |

Every run reported success. Three lost a whole chunk of speech, and every run trimmed its output.

## How this was measured

Each run's cache (`llm-calls.jsonl` keeps every raw Gemini reply) was cloned and replayed offline. The replay of
0.1.1 reproduces all 17 shipped `final.json` files exactly, so the same replies can be pushed through any version
of the pipeline. Each transcript is measured against the words AssemblyAI heard: **missing words** are runs of 12
or more ASR content words with no matching transcript word within 10 s; **agreement** is the share of ASR content
words found in the transcript within 10 s.

| #   | Issue                                                                                    | Status    |
| --- | ---------------------------------------------------------------------------------------- | --------- |
| 1   | A chunk comes back short (cut off, `[silence]`, repetition loop) and ships as success      | **FIXED** |
| 2   | Overlap ownership decided on the LLM's clock drops a chunk's opening lines               | **FIXED** |
| 3   | A few words matched far apart, or not at all, stretch over a gap and hide it from gap-fill | **FIXED** |
| 4   | Gap-fill's "already in the next segment" check passes any gap before a long turn         | **FIXED** |
| 5   | Finalize clamps end times to start + 7 s and drops turns under 0.2 s                      | **FIXED** |
| 6   | A recording in a language the ASR didn't expect loses lines                              | **FIXED** |
| 7   | Receipts leave out thinking tokens                                                       | **FIXED** |
| 8   | Gemini 4 (Argon, Carbon, Hydrogen) and 3.8 Flash on offmute's prompt                     | §8        |
| —   | Still open                                                                               | §9        |

## 1. A chunk comes back short → FIXED

- **M11:** the last chunk's reply stopped after one minute of ten; the transcript ends at 54:52 of 64:30 (932
  missing words).
- **M12:** one chunk came back as a single `[silence]` line over ten minutes of conversation (598).
- **M16:** a re-run's second chunk was the same filler word 600 times (678); 0.1.1's validation passed it.

In a nine-chunk bake-off (§8) the same model failed this way in 8 of 24 attempts on hard chunks, while the
same prompt on other models didn't. Prompt rewrites traded one failure for another (one fixed five of six hard
attempts and cut a Korean chunk off at one minute), so the fix is model-agnostic.

**Fix:** a coverage guard (`src/transcribe/coverage.ts`, pipeline step 4.1). After each chunk, its word count is
compared with the ASR's words for the same span. Under 60% (judged only when the ASR heard 200 words or more), the
chunk is transcribed again as two halves overlapping by 5 s (`src/core/retranscribe.ts`), the version with more
words is kept, and the retry is cached as `chunk_XX_retry_parsed.json`. The ASR now starts alongside Gemini
rather than after it, so the guard doesn't add a wait.

On the 17 meetings it flagged exactly those 3 of 84 judged chunks. Live, with 3.1 Pro: M11 60 → 2,055 words
($0.17), M12 289 → 1,912 ($0.16), M16 648 → 1,849 ($0.15), and no missing words afterwards.

## 2. Ownership on the LLM's clock → FIXED

Chunks overlap by 60 s, and a segment whose centre falls before a chunk's hand-over time belongs to the previous
chunk. That was decided on the LLM's own timestamps, before alignment. Gemini sometimes starts a chunk's clock
early: in M16 one chunk stamped its first line 59 s before it was spoken, so the line was dropped as "overlap"
while the previous chunk had stopped at the hand-over. Three of the four remaining hole sites were 10–50 s after
a hand-over.

**Fix:** `toAsrClock` (`src/align/aligner.ts`) aligns each chunk's segments to the ASR words in that chunk's own
audio and moves each segment by the shift of its nearest confirmed neighbour (3+ words matched and 60%+ of its
words) before ownership is decided. With only half its words required, a line the ASR heard worded differently
matched common words a minute away and moved its whole chunk there.

## 3. Stretched and unconfirmed segments → FIXED

Field report 1 bounded alignment to each chunk's audio. Inside a chunk it still happened: a 6-word line spanned
65 s because one filler word matched a minute early, and a 3-word line with no matched word was spread over the
22 s between its neighbours. Both covered speech the ASR heard and hid it from gap-fill (M12 kept a 111-word hole
this way).

**Fix:** a segment longer than max(30 s, 3 s per word) keeps its densest run of matched words (split where timed
words are 8 s apart); a segment with no exact match whose span exceeds max(5 s, 3× its speaking length) gets a
speaking-length span (0.5 s a word) at its start.

## 4. Gap-fill skips a real gap before a long turn → FIXED

Gap-fill skips a gap whose ASR words are already in the following segment (a late start, not a drop). The check
used every word of that segment, so a 922-word turn "contained" a 12-word gap. It now checks only the segment's
opening words (the gap's length plus 5).

## 5. Finalize trims what it got right → FIXED

0.1.1 clamped every segment's end to start + 7 s (1,441 of 5,048 segments) and dropped segments under 0.2 s (797
segments, 2,106 words, mostly backchannels the aligner placed at one point). End times are now kept, and only
empty segments are dropped: 5,048 → 5,607 segments, of which 43 still end before their last word.

## 6. A language the ASR didn't expect → FIXED

On M15 (Korean), AssemblyAI returned 31 English words for 9 minutes, and 19 of 31 lines were dropped. Left
unset, AssemblyAI assumes English. Now:

- without `--language`, AssemblyAI is asked to detect each file's language: M15 comes back as 880 Korean words,
  and an English meeting's 2,549 words are unchanged (tested live, $0.06);
- `--language <code>` pins the language for every ASR provider;
- when the ASR hears far fewer words than the transcript (ratio > 3, 200+ words), offmute warns, times lines by
  the LLM alone, and skips gap-fill, so wrong-language ASR text never enters the transcript;
- the AssemblyAI cache key includes the language only when one is given, so existing caches stay valid.

## 7. Receipts leave out thinking → FIXED

Across 114 cached Gemini 3.1 Pro calls, receipts showed $10.34; the 142,846 thinking tokens they omitted add
$1.71 (+17%). Thinking is now billed as output (`src/providers/gemini-usage.ts`), prices are dated to November
2026 (Argon and Carbon go to $4/$20 per M tokens on 1 Dec 2026; 3.8 Flash and the 3.6/3.5 Flash family double on
1 Jan 2027), and Gemini 4 uses LOW thinking (it rejects MINIMAL and can't turn thinking off).

## Results

| code | missing, 0.1.1 | missing, field-report-1 | missing, this branch | agreement 0.1.1 → branch |
| ---- | -------------- | ----------------------- | -------------------- | ------------------------ |
| M01  | 135            | 0                       | 0                    | 91.3% → 95.0%            |
| M02  | 0              | 18                      | 0                    | 95.3% → 96.2%            |
| M05  | 15             | 21                      | 0                    | 96.8% → 97.0%            |
| M07  | 15             | 15                      | 15                   | 89.9% → 90.0%            |
| M11  | 932            | 0                       | 33 (0 with the guard) | 81.2% → 94.3%           |
| M12  | 598            | 111                     | 0                    | 82.5% → 90.1%            |
| M16  | 678            | 32                      | 0                    | 79.9% → 94.0%            |
| others (10) | 0       | 0                       | 0                    | unchanged to +1.2 points; M15 not meaningful (wrong-language ASR) |
| **all 17** | **2,373** | **197**                | **48**               | mean (16, without M15) 91.9% → 94.5% |

The replay makes no API calls, so the guard's retries aren't in these numbers; M11's 33 words appear only when its
failed chunk isn't retried. 124 tests pass (21 new); `tsc` and `eslint` are clean.

## 8. Gemini 4 on offmute's prompt

Nine 10-minute chunks from these meetings (three of them the chunks 0.1.1 lost, which favours the other models
there), offmute's own prompt, thinking LOW, scored against ElevenLabs Scribe v2 and Gemini 3.5 Transcribe:

| model                    | speech kept | failed attempts | $ / audio hour        | s / chunk |
| ------------------------ | ----------- | --------------- | --------------------- | --------- |
| `gemini-3.1-pro-preview` | 72.9%       | 8 of 24         | 0.74                  | 39        |
| `gemini-4-hydrogen`      | 96.6%       | 0 of 11         | 0.74                  | 44        |
| `gemini-4-argon`         | 97.3%       | 0 of 11         | 0.67 (1.34 from 1 Dec) | 74       |
| `gemini-4-carbon`        | 97.0%       | 0 of 11         | 0.70 (1.40 from 1 Dec) | 109      |
| `gemini-3.8-flash`       | 77.3%       | 2 of 11         | 0.27 (0.54 from 1 Jan) | 55       |

On chunks every model completed, speaker labels agreed with the references 96–97% for Gemini 4 and 84% for
3.1 Pro. Hydrogen on four whole meetings lost no chunk and agreed with the ASR 0.2–1.2 points less than 3.1 Pro
(one run each). The default model is unchanged; `offmute-v2 models` lists Hydrogen, 3.8 Flash and Argon.

## 9. Still open

- A chunk whose two-half retry also fails can still lose about 30 words: the main alignment pass orders lines by
  the corrected clocks but doesn't use them as a time window.
- Chinese and Japanese text isn't split into words, so alignment and the guard count it poorly.
- A silent last chunk fails the 3-segment minimum and is retried once (about $0.02).
- Argon and Carbon's REST non-streaming output caps at 32,768 tokens; the browser path asks for 65,536.
