/**
 * Per-model Gemini request settings shared by the Node client (gemini.ts) and the
 * browser's fetch client (gemini-fetch.ts). Pure functions, no SDK: the browser build
 * imports this file.
 */

/**
 * Per-model "thinking" configuration. The control is NOT uniform across the Gemini family,
 * and the wrong/default level makes some models (esp. 3.x **pro**) over-think long audio —
 * e.g. ~7x slower for transcription, which doesn't benefit from heavy reasoning. We tame it:
 *  - gemini-4-*    → `thinkingLevel: LOW`, the lowest Gemini 4 accepts (it rejects MINIMAL and
 *                    cannot turn thinking off; its defaults are MEDIUM, or HIGH on Hydrogen)
 *  - gemini-2.5-*  → `thinkingBudget` (flash can disable with 0; pro can't fully disable → 128)
 *  - *-latest      → `thinkingLevel: LOW`: the aliases follow Google's newest model, whose
 *                    floor may be LOW (gemini-flash-latest rejected MINIMAL in Nov 2026)
 *  - gemini-3.x    → `thinkingLevel` (pro can't take MINIMAL → floor to LOW; flash MINIMAL)
 *  - gemini-2.0-*  → no thinking control
 * Returns the `thinkingConfig` fragment, or undefined when the model takes none.
 */
export function resolveThinking(model: string): Record<string, unknown> | undefined {
  const m = model.toLowerCase();
  if (m.includes("gemini-2.0")) return undefined;
  if (m.includes("gemini-4")) return { thinkingLevel: "LOW" };
  if (m.includes("gemini-2.5")) {
    return { thinkingBudget: m.includes("pro") ? 128 : 0 };
  }
  if (m.includes("-latest")) return { thinkingLevel: "LOW" };
  // 3.x (gemini-3-*, gemini-3.1-*, …) uses thinkingLevel. Pro rejects MINIMAL, so floor it to LOW.
  if (m.includes("gemini-3"))
    return { thinkingLevel: m.includes("pro") ? "LOW" : "MINIMAL" };
  return undefined;
}

/** The thinking config to retry with after a model rejected `rejected`: MINIMAL steps up
 * to LOW (a moving alias may now point at a model whose floor is LOW); anything else is
 * dropped, leaving the model's default. */
export function fallbackThinking(
  rejected: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return rejected.thinkingLevel === "MINIMAL" ? { thinkingLevel: "LOW" } : undefined;
}

/** Whether an error message looks like the model rejected our thinking config. */
export function isThinkingConfigError(message: string | undefined): boolean {
  if (!message) return false;
  return (
    /thinking/i.test(message) &&
    /(not supported|invalid|unsupported|unknown name|unexpected)/i.test(message)
  );
}

/** The largest `maxOutputTokens` a model takes on a plain (non-streaming) REST
 * generateContent call. Gemini 4 Argon and Carbon answer a larger request there with a
 * 400; streaming calls and SDK calls take 65,536 on every current model. */
export function maxNonStreamingOutput(model: string): number {
  return /gemini-4-(argon|carbon)/i.test(model) ? 32_768 : 65_536;
}
