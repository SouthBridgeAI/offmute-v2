/**
 * Model-aware "thinking" configuration for Gemini. The thinking control is NOT
 * uniform across the family (this bit us in review):
 *   - Gemini 2.5 uses `thinkingBudget` (an integer); `thinkingLevel` → 400.
 *   - Gemini 2.0 has no thinking at all; setting either → 400.
 *   - Gemini 3.x FLASH accepts `thinkingLevel`, including MINIMAL.
 *   - Gemini 3.x PRO accepts `thinkingLevel` but NOT MINIMAL (needs LOW+).
 * We accept a single semantic intensity (MINIMAL..HIGH) and translate it to
 * whatever the target model accepts. Browser-safe (no deps).
 */
export type ThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

const BUDGET_BY_LEVEL: Record<ThinkingLevel, { flash: number; pro: number }> = {
  // 2.5: flash can disable (0); pro cannot go below ~128.
  MINIMAL: { flash: 0, pro: 128 },
  LOW: { flash: 2048, pro: 2048 },
  MEDIUM: { flash: 8192, pro: 8192 },
  HIGH: { flash: 24576, pro: 24576 },
};

/**
 * Translate a requested thinking level (or explicit budget) into the
 * `thinkingConfig` object the given model accepts. Returns `undefined` when no
 * thinking config should be sent (e.g. Gemini 2.0, which has none).
 */
export function resolveThinkingConfig(
  model: string,
  level?: ThinkingLevel,
  explicitBudget?: number
): Record<string, unknown> | undefined {
  const m = model.toLowerCase();
  const isPro = m.includes("pro");

  // An explicit budget is honored on budget-capable (2.5) models only.
  if (explicitBudget !== undefined && m.includes("gemini-2.5")) {
    return { thinkingBudget: explicitBudget };
  }
  if (level === undefined) return undefined;

  if (m.includes("gemini-2.5")) {
    return { thinkingBudget: BUDGET_BY_LEVEL[level][isPro ? "pro" : "flash"] };
  }
  if (m.includes("gemini-2")) {
    return undefined; // 2.0 family: no thinking control
  }
  if (isPro) {
    // 3.x pro (incl. pro-latest / pro-preview) rejects MINIMAL — floor at LOW.
    return { thinkingLevel: level === "MINIMAL" ? "LOW" : level };
  }
  // 3.x flash (incl. flash-latest) and anything else: level as requested.
  return { thinkingLevel: level };
}

/** True if an API error is about an unsupported thinking config (so we can fall back). */
export function isThinkingConfigError(err: unknown): boolean {
  const msg = ((err as { message?: string })?.message ?? String(err)).toLowerCase();
  return /thinking[_ ]?(level|budget)|thinking.*(not supported|unsupported)/.test(msg);
}
