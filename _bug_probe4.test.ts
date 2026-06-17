import { test } from "bun:test";
import { secondsToSrtTime } from "./src/core/time.ts";
import { mergeChunkSegments } from "./src/core/chunk.ts";

// J. carry: 3599.9999 -> should be 01:00:00,000. and 59.9999, and 86399.9999
test("carry chain", () => {
  for (const v of [0.9999, 59.9999, 3599.9999, 119.9996, 7199.9999]) {
    console.log(v, "->", secondsToSrtTime(v));
  }
});

// K. mergeChunkSegments transitivity: A kept, B dup-of-A replaces A, but C was dup-of-B not A.
// Since we only compare against kept, if B replaced A in place, fine. But if two distinct kept
// segments both partially overlap a new seg, find() picks first only.
test("merge chain A<-B, then C overlaps only the replaced region", () => {
  const segs=[
    {start:0, end:10, speakerLabel:"A", text:"alpha beta gamma delta", matchRatio:0.3, chunkIndex:0},
    {start:0, end:10, speakerLabel:"A", text:"alpha beta gamma delta", matchRatio:0.9, chunkIndex:1}, // replaces above
  ];
  const chunks=[{index:0,startSeconds:0,endSeconds:10},{index:1,startSeconds:0,endSeconds:20}];
  const m=mergeChunkSegments(segs as any, chunks);
  console.log("replace-in-place:", m.map(x=>[x.matchRatio, x.chunkIndex]));
});

// L. equal-score replacement: identical scores -> NOT replaced (strict >). Confirm older kept.
test("merge equal score keeps first", () => {
  const segs=[
    {start:0, end:10, speakerLabel:"A", text:"same text here now", matchRatio:0.5, chunkIndex:0},
    {start:0, end:10, speakerLabel:"A", text:"same text here now", matchRatio:0.5, chunkIndex:0},
  ];
  const chunks=[{index:0,startSeconds:0,endSeconds:10}];
  const m=mergeChunkSegments(segs as any, chunks);
  console.log("equal score count:", m.length);
});
