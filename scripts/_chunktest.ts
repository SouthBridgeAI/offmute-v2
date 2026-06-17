import { transcribe } from "../src/pipeline.js";
const r = await transcribe(import.meta.dir+"/../../test-files/1/talk-with-questions.mov", {
  useVideo: false,
  intermediatesDir: import.meta.dir+"/../../intermediates/chunk-test",
  instructions: "The main speaker presenting on stage is Hrishi (also called Rishi). Everyone else is an audience member — label ALL audience members as 'Audience'.",
  maxSinglePassMinutes: 15, chunkMinutes: 15, chunkOverlapMinutes: 2,
  onProgress: (e) => process.stderr.write(`\n[${e.stage}] ${e.message}`),
});
require("fs").writeFileSync(import.meta.dir+"/../../intermediates/chunk-test/transcript.srt", r.srt);
console.log(`\nDONE: ${r.transcript.segments.length} segments, speakers: ${r.transcript.speakers.map(s=>s.label).join(", ")}`);
