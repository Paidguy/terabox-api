import { ApiError } from "./errors";
import { log } from "./log";

/**
 * Cloudflare allows 50 external subrequests per request on the Workers Free
 * plan (1,000 on Paid). Every upstream call in a request — including retries,
 * mirror fallbacks and folder recursion — draws from one shared budget so no
 * combination of features can blow that ceiling.
 *
 * 40 leaves headroom for the response stream itself and for a re-resolve.
 */
export const DEFAULT_BUDGET = 40;

export interface FetchOptions {
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  redirect?: "follow" | "manual" | "error";
  /** Per-attempt timeout in ms. Default 15000. */
  timeoutMs?: number;
  /** Extra attempts after the first. Default 1. Each costs budget. */
  retries?: number;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Budget {
  private spent = 0;

  constructor(private readonly limit: number = DEFAULT_BUDGET) {}

  get remaining(): number {
    return Math.max(0, this.limit - this.spent);
  }

  get used(): number {
    return this.spent;
  }

  /** True when at least `n` calls are still affordable. */
  canAfford(n = 1): boolean {
    return this.remaining >= n;
  }

  private take(): void {
    if (this.remaining <= 0) throw ApiError.budgetExhausted();
    this.spent += 1;
  }

  /**
   * `fetch` with a per-attempt timeout, bounded retries, and budget accounting.
   * Retries stop early when the budget runs low rather than throwing, so a
   * nearly-exhausted request still returns whatever the last attempt produced.
   */
  async fetch(url: string, options: FetchOptions = {}): Promise<Response> {
    const { timeoutMs = 15_000, retries = 1, ...init } = options;
    let lastError: unknown = null;
    let lastTimedOut = false;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (!this.canAfford()) {
        if (attempt === 0) throw ApiError.budgetExhausted();
        break;
      }
      if (attempt > 0) {
        await sleep(200 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100));
      }

      this.take();

      // The timeout covers "time until the response headers arrive" only.
      //
      // `AbortSignal.timeout(ms)` would be simpler, but it stays armed for the
      // life of the request: once it fires it also errors the response *body*
      // stream. For a proxy that's fatal — `/stream` would cut every download
      // off at `timeoutMs` (30s) however healthy the transfer, and `/segment`
      // at 15s. So the timer is cleared as soon as `fetch` resolves, and the
      // body is left to stream for as long as the client keeps reading it.
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        if (RETRYABLE_STATUS.has(response.status) && attempt < retries && this.canAfford()) {
          lastError = new Error(`upstream status ${response.status}`);
          // Nothing will read this body; release the connection.
          void response.body?.cancel().catch(() => undefined);
          continue;
        }
        return response;
      } catch (err) {
        lastError = err;
        lastTimedOut = timedOut;
      } finally {
        clearTimeout(timer);
      }
    }

    // The underlying reason goes to the log, never to the caller: an
    // exception message can carry internal detail, and this path catches
    // arbitrary throws from the runtime, not just network errors.
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    log("warn", "upstream request failed", {
      attempts: retries + 1,
      reason,
      timed_out: lastTimedOut,
    });

    throw ApiError.upstream(
      lastTimedOut
        ? `TeraBox did not respond within ${timeoutMs}ms.`
        : `Could not reach TeraBox after ${retries + 1} attempt(s).`,
    );
  }
}

/** Parse a JSON body defensively — TeraBox answers HTML when it blocks you. */
export async function readJson<T>(response: Response, context: string): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const preview = text.slice(0, 120).replace(/\s+/g, " ");
    throw ApiError.upstreamUnexpected(
      `TeraBox returned a non-JSON response while ${context}. The session cookie may have expired, or the request was blocked.`,
      { preview },
    );
  }
}
