/**
 * Validate the BROWSER orchestrator end-to-end in Node by giving it an FFmpegLike
 * shim backed by native ffmpeg (the only swap; the fetch providers, core, chunking,
 * identify, format are the real browser code paths).
 * Run: bun run scripts/test-browser-pipeline.ts [clip]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { transcribeInBrowser } from "../src/browser-pipeline.js";
import type { FFmpegLike } from "../src/media/ffmpeg-wasm.js";

class NodeFFmpeg implements FFmpegLike {
  dir = mkdtempSync(join(tmpdir(), "offmute-ff-"));
  async writeFile(path: string, data: Uint8Array | string) {
    writeFileSync(join(this.dir, path), data as Uint8Array);
  }
  async readFile(path: string) {
    return new Uint8Array(readFileSync(join(this.dir, path)));
  }
  async exec(args: string[]) {
    await new Promise<void>((resolve, reject) => {
      const p = spawn("ffmpeg", ["-y", ...args], { cwd: this.dir });
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}: ${err.slice(-300)}`))));
    });
  }
  async deleteFile(path: string) {
    try {
      unlinkSync(join(this.dir, path));
    } catch {
      /* ignore */
    }
  }
}

const clip = process.argv[2] ?? "talk-clip-0-180";
const bytes = new Uint8Array(readFileSync(join(import.meta.dir, `../../intermediates/media/${clip}.mp3`)));

const ffmpeg = new NodeFFmpeg();
console.log(`Running BROWSER pipeline on ${clip}.mp3 (${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB) via native-ffmpeg shim…`);
const t0 = performance.now();
const res = await transcribeInBrowser(bytes, {
  ffmpeg,
  apiKeys: { gemini: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "", assemblyai: process.env.ASSEMBLYAI_API_KEY ?? "" },
  instructions: "Main speaker is Hrishi; everyone else is 'Audience'.",
  useVideo: false,
  onProgress: (e) => process.stderr.write(`\n  [${e.stage}] ${e.message}`),
});
process.stderr.write("\n\n");
console.log(`Done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
console.log(`Speakers: ${res.transcript.speakers.map((s) => s.label).join(", ")}`);
console.log(`Segments: ${res.transcript.segments.length}`);
console.log("\n--- SRT (first 12 lines) ---");
console.log(res.srt.split("\n").slice(0, 12).join("\n"));
