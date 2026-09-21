import type { Env } from "../types";

const DEFAULT_LIMIT = 30;
const DEFAULT_WINDOW_SECONDS = 60;
/** Bound the bucket map so a flood of unique IPs can't exhaust isolate memory. */
const MAX_BUCKETS = 10_000;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets. */
  retryAfter: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw ?? "", 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

/**
 * Fixed-window counter, scoped to one isolate.
 *
 * Deliberately approximate: Cloudflare may run several isolates for one
 * worker, so the effective global limit is (limit x isolates). Its job is to
 * stop one client hammering the upstream TeraBox account into a temporary
 * ban — not to enforce billing-grade quotas. Set `RATE_LIMIT=0` to disable.
 */
export function checkRateLimit(env: Env, identity: string): RateLimitResult {
  if (env.RATE_LIMIT === "0") {
    return { allowed: true, limit: 0, remaining: 0, retryAfter: 0 };
  }

  const limit = positiveInt(env.RATE_LIMIT, DEFAULT_LIMIT);
  const windowSeconds = positiveInt(env.RATE_LIMIT_WINDOW, DEFAULT_WINDOW_SECONDS);
  const now = Date.now();
  const existing = buckets.get(identity);

  if (!existing || now >= existing.resetAt) {
    if (buckets.size >= MAX_BUCKETS) {
      for (const [key, bucket] of buckets) {
        if (now >= bucket.resetAt) buckets.delete(key);
      }
      if (buckets.size >= MAX_BUCKETS) {
        const oldest = buckets.keys().next();
        if (!oldest.done) buckets.delete(oldest.value);
      }
    }
    buckets.set(identity, { count: 1, resetAt: now + windowSeconds * 1000 });
    return { allowed: true, limit, remaining: limit - 1, retryAfter: windowSeconds };
  }

  const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
  if (existing.count >= limit) {
    return { allowed: false, limit, remaining: 0, retryAfter };
  }

  existing.count += 1;
  return { allowed: true, limit, remaining: limit - existing.count, retryAfter };
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  if (result.limit === 0) return {};
  return {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(result.retryAfter),
  };
}

/** Test-only: reset all counters between cases. */
export function _clearRateLimits(): void {
  buckets.clear();
}
