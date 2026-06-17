import { test } from "bun:test";
import { alignTurnsToSegments } from "./src/core/assemble.ts";
import { fillTokenTimes, alignLlmToAsr } from "./src/core/align.ts";

// G. Chunked: a chunk's turns aligned against windowed words but totalDuration=full file.
// Unmatched trailing tokens get pushed to chunk's last matched end (fine), but leading
// unmatched (before first match) get first matched start. What about a turn that has NO
// matches in this window? fillTokenTimes spreads across [0,totalDuration]=full file -> absolute 0..fulldur.
test("chunk window no-match turn spreads across full file", () => {
  // chunk covers 600-1200s. turn has words not present in ASR window -> no matches.
  const turns=[{text:"completely novel unmatched phrase here"}];
  const asrWindow=[ // words from this window, none match the turn
    {text:"different",start:605,end:606,speaker:"A"},
    {text:"words",start:606,end:607,speaker:"A"},
  ];
  const {segments} = alignTurnsToSegments(turns as any, asrWindow as any, 3600 /*full file*/, false);
  console.log("no-match-in-window seg times:", segments.map(s=>[s.start,s.end,s.matchRatio]));
});

// H. alignTurnsToSegments drops ALL segments when matchedTokens==0 for every turn -> empty.
test("all turns zero match -> dropped", () => {
  const turns=[{text:"xyzzy plugh"},{text:"foo bar"}];
  const asr=[{text:"hello",start:1,end:2},{text:"world",start:2,end:3}];
  const {segments} = alignTurnsToSegments(turns as any, asr as any, 10, false);
  console.log("dropped-all segments.length:", segments.length);
});

// I. interpolateTimings is exported but used? check fillTokenTimes trailing when last token end is null
test("fillTokenTimes single matched token in middle", () => {
  const toks=[
    {surface:"a",norm:"a",turnIndex:0,start:null,end:null,matched:false},
    {surface:"b",norm:"b",turnIndex:0,start:5,end:6,matched:true},
    {surface:"c",norm:"c",turnIndex:0,start:null,end:null,matched:false},
  ];
  fillTokenTimes(toks as any, 100);
  console.log("single-anchor fill:", toks.map(t=>[t.surface,t.start,t.end]));
});
