import { test } from "bun:test";
import { mergeChunkSegments } from "./src/core/chunk.ts";
import { alignLlmToAsr, fillTokenTimes, buildSegmentsFromTokens } from "./src/core/align.ts";
import { parseSrt, splitSpeakerPrefix } from "./src/core/srt.ts";
import { parseDiarizedText } from "./src/core/parse-diarized.ts";

// A. merge merges DIFFERENT speakers if text similar enough (overlap dedup ignores speaker)
test("merge cross-speaker", () => {
  const segs = [
    {start:100,end:110,speakerLabel:"Alice",text:"yeah I think so too right",matchRatio:0.5,chunkIndex:0},
    {start:101,end:109,speakerLabel:"Bob",text:"yeah I think so too right",matchRatio:0.9,chunkIndex:1},
  ];
  const chunks=[{index:0,startSeconds:0,endSeconds:110},{index:1,startSeconds:90,endSeconds:200}];
  const m = mergeChunkSegments(segs as any, chunks);
  console.log("cross-speaker merged ->", m.length, JSON.stringify(m.map(x=>[x.speakerLabel,x.start,x.end])));
});

// B. interpolated gap split: gapToNext computed AFTER fillTokenTimes (interpolated times collapse gap)
test("gap split after fill", () => {
  const turns=[{text:"one two three four five six"}];
  // ASR matches first and last only, with a big real gap in the middle
  const asr=[
    {text:"one",start:0,end:0.5},
    {text:"six",start:30,end:30.5},
  ];
  const toks = alignLlmToAsr(turns, asr as any);
  fillTokenTimes(toks, 31);
  console.log("filled times:", toks.map(t=>[t.surface, t.start?.toFixed(1), t.matched]));
  const segs = buildSegmentsFromTokens(turns, toks, {subSegment:true, gapSplit:1.0, minChars:5});
  console.log("segments:", segs.length, segs.map(s=>[s.text, s.start.toFixed(1), s.end.toFixed(1)]));
});

// C. parseSrt: id line numeric AND timing on line 0 (no id). Test text that starts with digit-only first content line being eaten as id
test("parseSrt no-id block where first text line numeric-ish", () => {
  const srt = "00:00:01,000 --> 00:00:02,000\nHello there\n\n00:00:03,000 --> 00:00:04,000\nWorld";
  console.log("no-id:", JSON.stringify(parseSrt(srt).map(c=>[c.id,c.start,c.text])));
});

// D. splitSpeakerPrefix on times "00:01:02 --> ..." style or "12:34" in body
test("splitSpeakerPrefix time", () => {
  console.log(splitSpeakerPrefix("12:34 and then he left"));
  console.log(splitSpeakerPrefix("Note: this is important and a long sentence that keeps going on"));
});

// E. parseDiarized: bracket in speaker disallowed, but '[inaudible]' lines
test("parse bracket noise", () => {
  console.log(JSON.stringify(parseDiarizedText("[inaudible]")));
  console.log(JSON.stringify(parseDiarizedText("[00:10] [music playing]")));
});

// F. merge keeps BOTH halves of a split turn that overlaps a single big cue (data loss the other way)
test("merge split vs whole both kept = duplication", () => {
  const segs = [
    {start:100,end:105,speakerLabel:"A",text:"the quick brown fox",matchRatio:0.9,chunkIndex:0}, // chunk0 cue A
    {start:105,end:110,speakerLabel:"A",text:"jumps over lazy dog",matchRatio:0.9,chunkIndex:0}, // chunk0 cue B
    {start:100,end:110,speakerLabel:"A",text:"the quick brown fox jumps over lazy dog",matchRatio:0.95,chunkIndex:1}, // chunk1 whole
  ];
  const chunks=[{index:0,startSeconds:0,endSeconds:110},{index:1,startSeconds:95,endSeconds:200}];
  const m = mergeChunkSegments(segs as any, chunks);
  console.log("split-vs-whole ->", m.length, JSON.stringify(m.map(x=>[x.start,x.end,x.text])));
});
