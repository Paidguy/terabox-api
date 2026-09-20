import { ApiError, ErrorCode } from "./errors";
import type { Env } from "../types";

/**
 * Normalise one configured cookie value.
 *
 * Accepts a bare `ndus` value, a `ndus=...` pair, or a full cookie string with
 * several pairs — because all three are what people actually paste out of
 * DevTools, and silently mis-parsing one produces a confusing 502 later.
 */
export function normalizeCookie(raw: string): string {
  const trimmed = raw.trim().replace(/^["']|["']$/g, "");
  if (trimmed === "") return "";
  return trimmed.includes("=") ? trimmed : `ndus=${trimmed}`;
}

/** Split the configured secret into a pool of usable cookies. */
export function cookiePool(env: Env): string[] {
  const configured = env.TERABOX_COOKIE ?? "";
  return configured
    .split(",")
    .map(normalizeCookie)
    .filter((cookie) => cookie !== "");
}

/**
 * Pick one cookie for this request, along with its position in the pool.
 *
 * Rotating across several accounts spreads load so no single TeraBox account
 * absorbs all the traffic — the standard mitigation against an account being
 * throttled or banned. With one cookie configured this is a no-op.
 *
 * The slot is returned so it can be stored with a cached share: signed
 * download links are bound to the account that requested them, so whoever
 * reads the cache later has to keep using that same account (see `cookieAt`).
 */
export function pickCookieSlot(env: Env): { cookie: string; slot: number } {
  const pool = cookiePool(env);
  if (pool.length === 0) {
    throw new ApiError(
      ErrorCode.COOKIE_INVALID,
      "Server misconfigured: the TERABOX_COOKIE secret is not set. Run `wrangler secret put TERABOX_COOKIE`.",
      500,
    );
  }
  const slot = Math.floor(Math.random() * pool.length);
  return { cookie: pool[slot]!, slot };
}

export function pickCookie(env: Env): string {
  return pickCookieSlot(env).cookie;
}

/**
 * The cookie at a previously returned pool position, or null when there is
 * none — the pool shrank, or the entry predates slot tracking.
 */
export function cookieAt(env: Env, slot: number | undefined): string | null {
  if (slot === undefined || !Number.isInteger(slot) || slot < 0) return null;
  return cookiePool(env)[slot] ?? null;
}

/** Append the share unlock key returned by the password verify step. */
export function withUnlockKey(cookie: string, randsk: string): string {
  return randsk ? `${cookie}; BOXCLND=${randsk}` : cookie;
}
