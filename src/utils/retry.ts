/**
 * Retry with exponential backoff + jitter for transient failures (network blips,
 * 429/5xx). Non-transient errors (4xx auth/validation) rethrow immediately.
 */
import { logger } from "./logger.js";

const TRANSIENT_RE =
  /fetch failed|network|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket|aborted|HTTP (?:429|5\d\d)|status (?:429|5\d\d)|\b(?:429|500|502|503|504)\b/i;

export function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message} ${err.cause ?? ""}` : String(err);
  return TRANSIENT_RE.test(msg);
}

export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { retries?: number; baseDelayMs?: number } = {},
): Promise<T> {
  // 5 retries × exponential backoff ≈ a ~90s outage envelope — network blips that
  // kill uploads (observed repeatedly) often outlast a couple of quick retries.
  const retries = opts.retries ?? 5;
  const base = opts.baseDelayMs ?? 2000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isTransient(err)) throw err;
      const delay = base * 2 ** attempt * (0.7 + Math.random() * 0.6);
      logger.warn(
        `[${label}] transient failure (${err instanceof Error ? err.message : err}) — retry ${attempt + 1}/${retries} in ${(delay / 1000).toFixed(1)}s`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
