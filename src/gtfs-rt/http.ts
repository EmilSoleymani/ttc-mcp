export interface RetryOptions {
  /** Retries after the first attempt (default 2 — ADR-0001 conservative retry). */
  retries?: number;
  /** Base for full-jitter exponential backoff, in ms (default 250). */
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 250;

function isRetryableStatus(status: number): boolean {
  return status >= 500 && status < 600;
}

function fullJitterDelayMs(attempt: number, baseDelayMs: number): number {
  return Math.random() * baseDelayMs * 2 ** attempt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ADR-0001 conservative retry, applied unchanged to the GTFS-RT feed GETs
 * (docs/spec/stack-baseline.md "Caching & retry"): up to `retries` retries on
 * a network error or 5xx response, full-jitter exponential backoff. A 429 is
 * never retried — it's returned to the caller as-is, same as any other
 * non-5xx response.
 */
export async function fetchWithRetry(
  url: string,
  options: RetryOptions = {},
): Promise<Response> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchImpl(url);
      if (!isRetryableStatus(response.status)) return response;
      lastError = new Error(
        `GTFS-RT fetch of ${url} failed: HTTP ${String(response.status)}`,
      );
    } catch (error) {
      lastError = error;
    }
    if (attempt < retries) {
      await sleep(fullJitterDelayMs(attempt, baseDelayMs));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(
        `GTFS-RT fetch of ${url} failed after ${String(retries)} retries.`,
      );
}
