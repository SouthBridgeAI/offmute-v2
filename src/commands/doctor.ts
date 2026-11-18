/**
 * `offmute-v2 doctor` — first thing to run when something's off. Checks ffmpeg,
 * key presence, and live-pings each provider the keys claim to unlock. Read-only;
 * every ping is a cheap list/status endpoint.
 */
import { resolveKeys, type ApiKeys } from "../core/config.js";
import { DEFAULT_TRANSCRIBE_MODEL, PRO_TRANSCRIBE_MODEL } from "../core/models.js";
import { checkFfmpeg } from "../audio/ffmpeg.js";

interface Check {
  name: string;
  run: () => Promise<string>; // resolves to a detail string, throws on failure
}

async function ping(url: string, headers: Record<string, string>): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

function providerChecks(keys: ApiKeys): Check[] {
  const checks: Check[] = [];
  const add = (
    name: string,
    key: string | undefined,
    fn: (k: string) => Promise<void>,
  ) => {
    checks.push({
      name,
      run: async () => {
        if (!key) throw new Error("no key in environment");
        await fn(key);
        return "key valid, API reachable";
      },
    });
  };
  add("gemini (transcribe)", keys.gemini, (k) =>
    ping(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${k}`,
      {},
    ),
  );
  // The transcription models themselves: a key that can list models may still not reach
  // one (a lookup of a model it can't use is a 404).
  for (const [model, role] of [
    [DEFAULT_TRANSCRIBE_MODEL, "default"],
    [PRO_TRANSCRIBE_MODEL, "--pro"],
  ] as const) {
    checks.push({
      name: `${model} (${role})`,
      run: async () => {
        if (!keys.gemini) throw new Error("no key in environment");
        await ping(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}?key=${keys.gemini}`,
          {},
        );
        return "available to this key";
      },
    });
  }
  add("assemblyai (timestamped)", keys.assemblyai, (k) =>
    ping("https://api.assemblyai.com/v2/transcript?limit=1", { authorization: k }),
  );
  // Scoped ElevenLabs keys 401 on /v1/user but work for STT — probe the STT endpoint
  // itself: an empty POST returns 401 for a bad key, 4xx-validation for a good one.
  checks.push({
    name: "elevenlabs (timestamped)",
    run: async () => {
      if (!keys.elevenlabs) throw new Error("no key in environment");
      const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": keys.elevenlabs },
      });
      if (res.status === 401) throw new Error("HTTP 401 (bad key)");
      return "key valid, API reachable";
    },
  });
  add("groq (timestamped fallback)", keys.groq, (k) =>
    ping("https://api.groq.com/openai/v1/models", { Authorization: `Bearer ${k}` }),
  );
  add("deepseek (reasoner)", keys.deepseek, (k) =>
    ping("https://api.deepseek.com/v1/models", { Authorization: `Bearer ${k}` }),
  );
  add("openai (reasoner)", keys.openai, (k) =>
    ping("https://api.openai.com/v1/models", { Authorization: `Bearer ${k}` }),
  );
  add("zai / GLM (reasoner)", keys.zai, (k) =>
    ping("https://api.z.ai/api/paas/v4/models", { Authorization: `Bearer ${k}` }),
  );
  add("kimi / Moonshot (reasoner)", keys.kimi, (k) =>
    ping("https://api.moonshot.ai/v1/models", { Authorization: `Bearer ${k}` }),
  );
  return checks;
}

export async function runDoctor(): Promise<void> {
  const keys = resolveKeys();
  console.log("\noffmute-v2 doctor\n");

  // ffmpeg first — nothing works without it.
  const ff = await checkFfmpeg();
  console.log(
    `  ${ff ? "✓" : "✗"}  ffmpeg/ffprobe ${ff ? "found in PATH" : "NOT FOUND — install ffmpeg"}`,
  );

  const checks = providerChecks(keys);
  const results = await Promise.allSettled(checks.map((c) => c.run()));
  let usable = 0;
  results.forEach((r, i) => {
    const name = checks[i]!.name;
    if (r.status === "fulfilled") {
      usable++;
      console.log(`  ✓  ${name.padEnd(28)} ${r.value}`);
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      const mark = msg === "no key in environment" ? "–" : "✗";
      console.log(`  ${mark}  ${name.padEnd(28)} ${msg}`);
    }
  });

  console.log("");
  const okByName = (needle: string) =>
    checks.some(
      (c, i) => c.name.startsWith(needle) && results[i]?.status === "fulfilled",
    );
  // Transcription needs the key and the default model itself: a key can list models and
  // still be refused one.
  const keyOk = okByName("gemini (transcribe)");
  const modelOk = okByName(`${DEFAULT_TRANSCRIBE_MODEL} (default)`);
  const geminiOk = keyOk && modelOk;
  const assemblyOk = okByName("assemblyai");
  const elevenOk = okByName("elevenlabs");
  const groqOk = okByName("groq");
  if (ff && geminiOk && assemblyOk) {
    console.log("  Ready: transcription will work with the current setup.\n");
  } else if (ff && geminiOk && (elevenOk || groqOk)) {
    // A clock exists, but not the DEFAULT one — plain `offmute-v2 file.mp4` would still
    // fail on the missing AssemblyAI key, so say exactly which flag makes it work.
    const alt = elevenOk ? "--timestamped elevenlabs" : "--timestamped whisper-groq";
    console.log(
      `  Ready with ${alt}: the default clock (AssemblyAI) is missing, so plain runs will fail —`,
    );
    console.log(`  add ASSEMBLYAI_API_KEY or pass ${alt}.\n`);
  } else {
    if (!ff) console.log("  Blocked: install ffmpeg (e.g. `brew install ffmpeg`).");
    if (!keyOk)
      console.log(
        "  Blocked: set GEMINI_API_KEY (or GOOGLE_API_KEY) — required for transcription.",
      );
    else if (!modelOk)
      console.log(
        `  Blocked: this key can't use ${DEFAULT_TRANSCRIBE_MODEL}, the default — pass --model with one it can (\`offmute-v2 models\` lists them).`,
      );
    if (!assemblyOk && !elevenOk && !groqOk)
      console.log(
        "  Degraded: no timestamped provider (ASSEMBLYAI/ELEVENLABS/GROQ key) — timestamps will be coarse.",
      );
    console.log("");
  }
  void usable;
}
