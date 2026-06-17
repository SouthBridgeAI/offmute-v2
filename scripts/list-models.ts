/**
 * List available Gemini models for the configured key.
 * Usage: npx tsx scripts/list-models.ts
 */
import { GoogleGenAI } from "@google/genai";

async function main() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const out: string[] = [];
  const pager = await ai.models.list();
  for await (const m of pager) {
    const mod = (m as any).supportedGenerationMethods || [];
    out.push(
      `${m.name?.padEnd(34)} | ${m.displayName} | ${Array.isArray(mod) ? mod.join(",") : ""}`,
    );
  }
  console.log(out.sort().join("\n"));
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
