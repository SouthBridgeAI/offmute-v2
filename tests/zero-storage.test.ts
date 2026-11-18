import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiClient } from "../src/providers/gemini.js";
import { GeminiChatClient } from "../src/providers/gemini-chat.js";
import { AssemblyAIProvider } from "../src/providers/assemblyai.js";

/** A local server for `handler`, standing in for a provider's API. */
async function serve(
  handler: RequestListener,
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("the test server has no port");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
}

/** The request's body, once it has all arrived. */
async function body(req: Parameters<RequestListener>[0]): Promise<string> {
  let raw = "";
  for await (const chunk of req) raw += String(chunk);
  return raw;
}

describe("zero storage on Gemini requests", () => {
  // What Google receives, captured on a local server. @google/genai 2.30 and earlier accept
  // `store: false` in the config and send the request without it, and the call still
  // succeeds; inside generationConfig the API rejects it. So the test reads the wire.
  let server: Server;
  let baseUrl = "";
  const bodies: Record<string, unknown>[] = [];
  const paths: string[] = [];
  // What the next response says (a reply the test can parse as JSON, or plain text).
  let replyText = "pong";

  beforeAll(async () => {
    ({ server, baseUrl } = await serve(async (req, res) => {
      bodies.push(JSON.parse(await body(req)) as Record<string, unknown>);
      paths.push(req.url ?? "");
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = {
        candidates: [
          {
            content: { role: "model", parts: [{ text: replyText }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 3,
          candidatesTokenCount: 1,
          totalTokenCount: 4,
        },
      };
      res.end(`data: ${JSON.stringify(chunk)}\r\n\r\n`);
    }));
  });
  afterAll(() => stop(server));

  it("sends store: false at the request's top level by default", async () => {
    bodies.length = 0;
    const client = new GeminiClient("test-key", { baseUrl });
    const r = await client.generate("gemini-4-hydrogen", "ping", [], { maxRetries: 1 });
    expect(r.error).toBeUndefined();
    expect(r.text).toBe("pong");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.store).toBe(false);
    expect(bodies[0]!.generationConfig).not.toHaveProperty("store");
  });

  it("sends no store field when zero storage is off, leaving the project's setting", async () => {
    bodies.length = 0;
    const client = new GeminiClient("test-key", { baseUrl, zeroStorage: false });
    await client.generate("gemini-4-hydrogen", "ping", [], { maxRetries: 1 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("store");
  });

  it("asks through the native API on the speaker-naming pass, where store: false is accepted", async () => {
    // Gemini's OpenAI-compatible endpoint logs requests and rejects `store` in either
    // state; the naming pass sends the transcript, so it must not go there.
    bodies.length = 0;
    paths.length = 0;
    replyText = '{"speakers":[]}';
    const chat = new GeminiChatClient(
      new GeminiClient("test-key", { baseUrl }),
      "gemini-flash-latest",
    );
    const r = await chat.chatJson<{ speakers: unknown[] }>(undefined, [
      { role: "system", content: "Name the speakers." },
      { role: "user", content: "transcript text" },
    ]);
    replyText = "pong";
    expect(r.data).toEqual({ speakers: [] });
    expect(paths[0]).toContain("gemini-flash-latest:streamGenerateContent");
    expect(bodies[0]!.store).toBe(false);
    expect(bodies[0]!.generationConfig).toMatchObject({
      responseMimeType: "application/json",
    });
  });
});

describe("zero storage on AssemblyAI", () => {
  // AssemblyAI's API, faked: an upload, a job ("t-new"), finished jobs by id, a job that no
  // longer exists ("t-gone"), one already deleted ("t-deleted"), and a refused key ("t-refused").
  let server: Server;
  let baseUrl = "";
  const calls: string[] = [];
  const submitted: Record<string, unknown>[] = [];
  const finished = (id: string) => ({
    id,
    status: "completed",
    audio_duration: 2,
    language_code: "en",
    words: [{ text: "hello", start: 0, end: 400, confidence: 0.9, speaker: "A" }],
    utterances: [
      {
        speaker: "A",
        text: "hello",
        start: 0,
        end: 400,
        confidence: 0.9,
        words: [{ text: "hello", start: 0, end: 400, confidence: 0.9, speaker: "A" }],
      },
    ],
  });

  let dir = "";
  let audio = "";
  /** Where a run caches the transcript, and where a stopped run leaves its job's id. */
  let cacheName = "";

  beforeAll(async () => {
    ({ server, baseUrl } = await serve(async (req, res) => {
      const raw = await body(req);
      const url = req.url ?? "";
      calls.push(`${req.method} ${url}`);
      const reply = (status: number, json: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (url === "/v2/upload")
        return reply(200, { upload_url: "https://cdn.example/audio" });
      if (req.method === "POST" && url === "/v2/transcript") {
        submitted.push(JSON.parse(raw) as Record<string, unknown>);
        return reply(200, { id: "t-new", status: "queued" });
      }
      const id = /^\/v2\/transcript\/([^/?]+)/.exec(url)?.[1];
      if (id === "t-gone")
        return reply(404, { error: "Transcript lookup error, transcript id not found" });
      if (id === "t-refused")
        return reply(401, { error: "Authentication error, API token missing/invalid" });
      if (id === "t-deleted" && req.method === "GET") {
        return reply(200, {
          id,
          status: "completed",
          text: "Deleted by user.",
          words: null,
        });
      }
      if (id && req.method === "GET") return reply(200, finished(id));
      if (id && req.method === "DELETE") return reply(200, { id, status: "completed" });
      reply(404, { error: `unexpected ${req.method} ${url}` });
    }));
    dir = mkdtempSync(join(tmpdir(), "offmute-aai-"));
    audio = join(dir, "audio.mp3");
    const bytes = Buffer.from("not really audio");
    writeFileSync(audio, bytes);
    // The cache key: the audio's content hash and the request's options (here, a detected
    // language). Changing it means every cached transcript is paid for again.
    cacheName = `${createHash("sha256").update(bytes).digest("hex").slice(0, 24)}_lang-auto`;
  });
  afterAll(async () => {
    await stop(server);
    rmSync(dir, { recursive: true, force: true });
  });

  const provider = (cacheDir: string, zeroStorage?: boolean) =>
    new AssemblyAIProvider({ apiKey: "test-key", baseUrl, cacheDir, zeroStorage });

  it("deletes the transcript from AssemblyAI once offmute has its own copy", async () => {
    calls.length = 0;
    submitted.length = 0;
    const cacheDir = join(dir, "deletes");
    const r = await provider(cacheDir).transcribe(audio);
    expect(r.words.map((w) => w.text)).toEqual(["hello"]);
    expect(calls).toEqual([
      "POST /v2/upload",
      "POST /v2/transcript",
      "GET /v2/transcript/t-new",
      "DELETE /v2/transcript/t-new",
    ]);
    // Without a language, AssemblyAI is asked to detect one (it otherwise assumes English).
    expect(submitted[0]).toMatchObject({
      language_detection: true,
      speaker_labels: true,
    });
    expect(readdirSync(cacheDir)).toEqual([`${cacheName}.json`]);
  });

  it("leaves the transcript with AssemblyAI when zero storage is off", async () => {
    calls.length = 0;
    await provider(join(dir, "keeps"), false).transcribe(audio);
    expect(calls).not.toContain("DELETE /v2/transcript/t-new");
    expect(calls).toHaveLength(3);
  });

  it("picks up the job a stopped run left, instead of paying for the audio again", async () => {
    calls.length = 0;
    const cacheDir = join(dir, "resumes");
    const p = provider(cacheDir);
    // A stopped run: the job was submitted and its id saved, and nothing came back.
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, `${cacheName}.pending.json`),
      JSON.stringify({ id: "t-stopped" }),
    );
    const r = await p.transcribe(audio);
    expect(r.transcriptId).toBe("t-stopped");
    expect(p.lastFromCache).toBe(false);
    expect(calls).toEqual([
      "GET /v2/transcript/t-stopped",
      "DELETE /v2/transcript/t-stopped",
    ]);
    expect(existsSync(join(cacheDir, `${cacheName}.pending.json`))).toBe(false);
    expect(existsSync(join(cacheDir, `${cacheName}.json`))).toBe(true);
  });

  it("sends the audio again when the stopped run's job is gone", async () => {
    calls.length = 0;
    const cacheDir = join(dir, "gone");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, `${cacheName}.pending.json`),
      JSON.stringify({ id: "t-gone" }),
    );
    const r = await provider(cacheDir).transcribe(audio);
    expect(r.transcriptId).toBe("t-new");
    expect(calls).toEqual([
      "GET /v2/transcript/t-gone",
      "POST /v2/upload",
      "POST /v2/transcript",
      "GET /v2/transcript/t-new",
      "DELETE /v2/transcript/t-new",
    ]);
    expect(readdirSync(cacheDir)).toEqual([`${cacheName}.json`]);
  });

  /** A cache dir holding what a stopped run left: its job id, and optionally its copy. */
  const leftBehind = (name: string, id: string, cached?: boolean) => {
    const cacheDir = join(dir, name);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, `${cacheName}.pending.json`), JSON.stringify({ id }));
    if (cached) {
      writeFileSync(
        join(cacheDir, `${cacheName}.json`),
        JSON.stringify({ utterances: [], words: [], transcriptId: id }),
      );
    }
    return cacheDir;
  };

  it("keeps the stopped run's job when AssemblyAI refuses, so it's neither paid twice nor stranded", async () => {
    calls.length = 0;
    const cacheDir = leftBehind("refused", "t-refused");
    await expect(provider(cacheDir).transcribe(audio)).rejects.toThrow(/Authentication/);
    expect(calls).toEqual(["GET /v2/transcript/t-refused"]);
    expect(existsSync(join(cacheDir, `${cacheName}.pending.json`))).toBe(true);
  });

  it("finishes the delete a run stopped before it went through", async () => {
    calls.length = 0;
    const cacheDir = leftBehind("undeleted", "t-undeleted", true);
    const p = provider(cacheDir);
    await p.transcribe(audio);
    expect(p.lastFromCache).toBe(true);
    expect(calls).toEqual(["DELETE /v2/transcript/t-undeleted"]);
    expect(readdirSync(cacheDir)).toEqual([`${cacheName}.json`]);
  });

  it("treats a job that was already deleted as gone, rather than caching its empty transcript", async () => {
    calls.length = 0;
    const cacheDir = leftBehind("deleted", "t-deleted");
    const r = await provider(cacheDir).transcribe(audio);
    expect(r.words.map((w) => w.text)).toEqual(["hello"]);
    expect(calls.slice(0, 3)).toEqual([
      "GET /v2/transcript/t-deleted",
      "POST /v2/upload",
      "POST /v2/transcript",
    ]);
  });
});
