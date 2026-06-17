/** Transient-error retry with exponential backoff. Browser-safe (no Node deps). */

/** Is this a transient error worth retrying (overload, rate limit, 5xx, network)? */
export function isRetryableError(err: unknown): boolean {
  const e = err as { status?: number; code?: number; message?: string };
  const code = e?.status ?? e?.code;
  if (typeof code === "number" && [408, 429, 500, 502, 503, 504].includes(code)) return true;
  const msg = (e?.message ?? String(err)).toLowerCase();
  return /unavailable|overloaded|rate.?limit|deadline|timeout|temporar|try again|resource.?exhausted|\b(429|500|502|503|504)\b|internal error|econnreset|etimedout|socket hang|fetch failed|network/.test(
    msg
  );
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  /** called before each backoff sleep */
  onRetry?: (info: { attempt: number; retries: number; delayMs: number; error: unknown }) => void;
}

/** Retry an async op with exponential backoff + jitter on transient errors. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 4;
  const base = opts.baseDelayMs ?? 1000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetryableError(err)) throw err;
      const delayMs = Math.min(30000, base * 2 ** attempt) + Math.floor(Math.random() * 250);
      opts.onRetry?.({ attempt: attempt + 1, retries, delayMs, error: err });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
