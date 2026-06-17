import { test } from "bun:test";
import { parseSrt } from "./src/core/srt.ts";
// Block: numeric id, timing, body="42" -> body must remain "42", not be eaten as id
test("numeric body", () => {
  const srt="1\n00:00:01,000 --> 00:00:02,000\n42\n\n";
  const c=parseSrt(srt);
  console.log("numeric body:", JSON.stringify(c));
});
// Block with NO numeric id, 2 lines before we find timing? timing must be within first 2 lines
test("timing on line 2 (idx2) not found", () => {
  const srt="garbage line\nanother\n00:00:01,000 --> 00:00:02,000\nText";
  console.log("timing-idx2:", JSON.stringify(parseSrt(srt)));
});
// multi-line text joined
test("multiline text", () => {
  const srt="1\n00:00:01,000 --> 00:00:02,000\nLine one\nLine two";
  console.log("multiline:", JSON.stringify(parseSrt(srt)));
});
