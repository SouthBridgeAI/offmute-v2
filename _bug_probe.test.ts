import { test, expect } from "bun:test";
import { alignTokens, alignLlmToAsr, fillTokenTimes, buildSegmentsFromTokens, asrSpeakerByLabel } from "./src/core/align.ts";
import { calculateChunks, mergeChunkSegments } from "./src/core/chunk.ts";
import { secondsToSrtTime, srtTimeToSeconds, relTimeToSeconds } from "./src/core/time.ts";
import { parseDiarizedText } from "./src/core/parse-diarized.ts";
import { parseSrt } from "./src/core/srt.ts";

// 1. Empty inputs to alignTokens
test("alignTokens empty A", () => {
  const p = alignTokens([], ["a","b"]);
  console.log("empty A pairs:", JSON.stringify(p));
  expect(p.length).toBe(2);
});
test("alignTokens both empty", () => {
  const p = alignTokens([], []);
  console.log("both empty:", JSON.stringify(p));
});

// 2. fillTokenTimes NaN duration / single token
test("fillTokenTimes no matches NaN duration", () => {
  const toks = [{surface:"a",norm:"a",turnIndex:0,start:null,end:null,matched:false}];
  fillTokenTimes(toks as any, NaN);
  console.log("NaN duration single:", toks[0].start, toks[0].end);
});

// 3. secondsToSrtTime with NaN / negative / Infinity
test("secondsToSrtTime edge", () => {
  console.log("NaN ->", JSON.stringify(secondsToSrtTime(NaN)));
  console.log("Inf ->", JSON.stringify(secondsToSrtTime(Infinity)));
  console.log("-5 ->", JSON.stringify(secondsToSrtTime(-5)));
  console.log("59.9996 ->", JSON.stringify(secondsToSrtTime(59.9996)));
  console.log("3599.9996 ->", JSON.stringify(secondsToSrtTime(3599.9996)));
});

// 4. calculateChunks edge: zero/neg duration, overlap >= chunk
test("calculateChunks zero duration", () => {
  console.log("0 dur:", JSON.stringify(calculateChunks(0, 900, 120)));
});
test("calculateChunks overlap>=chunk", () => {
  console.log("overlap>=chunk:", JSON.stringify(calculateChunks(3000, 900, 1000)));
});
test("calculateChunks normal", () => {
  console.log("normal 2400/900/120:", JSON.stringify(calculateChunks(2400, 900, 120)));
});

// 5. mergeChunkSegments: subsegmented overlap with different cue boundaries
test("merge overlap different cue boundaries", () => {
  const segs = [
    // chunk 0 says one cue covering 100-110
    {start:100,end:110,speakerLabel:"A",text:"hello world how are you",matchRatio:0.9,chunkIndex:0},
    // chunk 1 (overlap) splits same speech into two cues
    {start:100,end:105,speakerLabel:"A",text:"hello world",matchRatio:0.9,chunkIndex:1},
    {start:105,end:110,speakerLabel:"A",text:"how are you",matchRatio:0.9,chunkIndex:1},
  ];
  const chunks = [{index:0,startSeconds:0,endSeconds:110},{index:1,startSeconds:90,endSeconds:200}];
  const merged = mergeChunkSegments(segs as any, chunks);
  console.log("merged dup count:", merged.length, JSON.stringify(merged.map(m=>[m.start,m.end,m.text])));
});

// 6. relTimeToSeconds with [mm:ss] like "100:00" minutes overflow ok; check "5:3"
test("relTime", () => {
  console.log("'5:3' ->", relTimeToSeconds("5:3"));
  console.log("'1:2:3' ->", relTimeToSeconds("1:2:3"));
});

// 7. parse-diarized: line with colon in text but no speaker, and URL
test("parse url line", () => {
  console.log(JSON.stringify(parseDiarizedText("[00:05] Alice: check http://example.com now")));
  console.log("=== no-speaker line with time colon ===");
  console.log(JSON.stringify(parseDiarizedText("Visit at 3: it works")));
});

// 8. parseSrt block where numeric id line and timing both, but text is a number
test("parseSrt numeric body", () => {
  const srt = "1\n00:00:01,000 --> 00:00:02,000\n42\n\n";
  console.log(JSON.stringify(parseSrt(srt)));
});
