import { ApiError, ErrorCode } from "./errors";
import type { Env } from "../types";

/** Segment tokens live just long enough to play through a manifest. */
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Derive the signing key from server-side secrets.
 *
 * Reusing the existing secrets avoids adding another required binding, and
 * the derived key never leaves the worker — only signatures do. The key
 * rotates automatically whenever the cookie or API key is rotated, which
 * invalidates outstanding tokens as a side effect.
 */
async function signingKey(env: Env): Promise<CryptoKey> {
  const material = `terabox-api:${env.TERABOX_COOKIE ?? ""}:${env.API_KEY ?? ""}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/**
 * Mint a token that authorises proxying exactly one upstream URL.
 *
 * This is what keeps `/segment` from being an open proxy: the endpoint only
 * ever fetches URLs this worker itself signed, so a caller cannot point it at
 * an arbitrary host the way the `?url=` designs in similar projects allow.
 */
export async function mintSegmentToken(env: Env, url: string, slot?: number): Promise<string> {
  // `s` pins the token to one account in the cookie pool: the segment URLs in a
  // manifest were signed for the account that fetched it.
  const payload = JSON.stringify(
    slot === undefined
      ? { u: url, e: Date.now() + TOKEN_TTL_MS }
      : { u: url, e: Date.now() + TOKEN_TTL_MS, s: slot },
  );
  const encoded = base64UrlEncode(new TextEncoder().encode(payload));
  const key = await signingKey(env);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded));
  return `${encoded}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Verify a token and return the URL it authorises. */
export async function readSegmentToken(env: Env, token: string): Promise<string> {
  return (await readSegmentClaims(env, token)).url;
}

/** Verify a token and return everything it carries. */
export async function readSegmentClaims(
  env: Env,
  token: string,
): Promise<{ url: string; slot: number | undefined }> {
  const invalid = () =>
    new ApiError(ErrorCode.INVALID_PARAMETER, "That segment token is invalid or has expired.", 403);

  const parts = token.split(".");
  if (parts.length !== 2) throw invalid();
  const [encoded, signature] = parts as [string, string];

  let verified = false;
  try {
    const key = await signingKey(env);
    verified = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlDecode(signature),
      new TextEncoder().encode(encoded),
    );
  } catch {
    throw invalid();
  }
  if (!verified) throw invalid();

  let payload: { u?: unknown; e?: unknown; s?: unknown };
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded)));
  } catch {
    throw invalid();
  }

  if (typeof payload.u !== "string" || typeof payload.e !== "number") throw invalid();
  if (Date.now() > payload.e) throw invalid();
  return { url: payload.u, slot: typeof payload.s === "number" ? payload.s : undefined };
}
