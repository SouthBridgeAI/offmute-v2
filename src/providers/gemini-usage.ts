/**
 * Gemini token usage, shared by the SDK client (node) and the fetch client (browser).
 * Dependency-free so the browser bundle can import it without the SDK.
 */

export interface GeminiUsage {
  inputTokens: number;
  /** Billed output: the visible answer plus thinking (both are charged at the output
   * rate). Leaving thinking out under-reported 3.1 Pro spend by ~16% in real runs. */
  outputTokens: number;
  /** The thinking share of `outputTokens`, kept for the call log. */
  thoughtTokens?: number;
  totalTokens: number;
}

/** Usage from a Gemini `usageMetadata` block. */
export function usageFromMetadata(
  meta:
    | {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
        totalTokenCount?: number;
      }
    | undefined,
): GeminiUsage {
  const thoughtTokens = meta?.thoughtsTokenCount ?? 0;
  return {
    inputTokens: meta?.promptTokenCount ?? 0,
    outputTokens: (meta?.candidatesTokenCount ?? 0) + thoughtTokens,
    thoughtTokens,
    totalTokens: meta?.totalTokenCount ?? 0,
  };
}
