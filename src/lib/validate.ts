import { ApiError } from "./errors";

/**
 * Registrable domains a share *link* may point at.
 *
 * A host matches when it equals one of these or is a subdomain of it
 * (`dm.terabox.app`, `www.1024terabox.com`). Matching on a leading dot rather
 * than a substring is what stops `terabox.app.evil.com` slipping through.
 *
 * Checked before the worker fetches anything a caller supplied, so this can't
 * be turned into a general-purpose URL fetcher (SSRF).
 */
export const SHARE_DOMAINS = [
  "terabox.com",
  "terabox.app",
  "terabox.club",
  "teraboxapp.com",
  "teraboxlink.com",
  "teraboxshare.com",
  "terasharelink.com",
  "terasharefile.com",
  "terafileshare.com",
  "terabox1.com",
  "terabox2.com",
  "1024terabox.com",
  "1024tera.com",
  "4funbox.com",
  "4funbox.co",
  "mirrobox.com",
  "nephobox.com",
  "momerybox.com",
  "tibibox.com",
  "freeterabox.com",
  "gibibox.com",
  "box-links.com",
] as const;

/**
 * Origins tried, in order, when the share's own host refuses a request.
 * TeraBox mirrors the same share record across these, and any one of them can
 * be blocked, throttled or CAPTCHA-walled independently of the others.
 */
export const MIRROR_ORIGINS = [
  "https://www.terabox.com",
  "https://www.1024terabox.com",
  "https://www.teraboxapp.com",
  "https://www.terabox.app",
] as const;

/**
 * Suffixes the *download* link may resolve to. The dlink always comes from
 * TeraBox's own API response, never from the caller, but this check is kept as
 * defence in depth so the proxy can never fetch an arbitrary host even if that
 * assumption is violated upstream.
 */
const DOWNLOAD_DOMAINS = [
  ...SHARE_DOMAINS,
  "teraboxcdn.com",
  "teraboxcdn.net",
  "dubox.com",
  "baidupcs.com",
  "terabox.fun",
] as const;

function hostMatches(host: string, domains: readonly string[]): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return domains.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}

export function isAllowedShareUrl(link: string): boolean {
  try {
    const parsed = new URL(link);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return hostMatches(parsed.hostname, SHARE_DOMAINS);
  } catch {
    return false;
  }
}

export function isAllowedDownloadUrl(link: string): boolean {
  try {
    const parsed = new URL(link);
    if (parsed.protocol !== "https:") return false;
    return hostMatches(parsed.hostname, DOWNLOAD_DOMAINS);
  } catch {
    return false;
  }
}

const MAX_LINK_LENGTH = 512;

/** Validate a caller-supplied share link, throwing a specific ApiError. */
export function parseShareLink(raw: unknown): URL {
  if (typeof raw !== "string" || raw.trim() === "") throw ApiError.missingParameter("link");

  const trimmed = raw.trim();
  if (trimmed.length > MAX_LINK_LENGTH) {
    throw ApiError.invalidParameter("link", `longer than ${MAX_LINK_LENGTH} characters.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw ApiError.invalidParameter("link", "not a valid absolute URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw ApiError.invalidParameter("link", "only http and https URLs are supported.");
  }
  if (!hostMatches(parsed.hostname, SHARE_DOMAINS)) {
    throw ApiError.unsupportedHost(parsed.hostname);
  }
  return parsed;
}

/**
 * Pull the short share id out of a share URL, normalised to the `1`-prefixed
 * form TeraBox's own APIs expect as `shorturl`.
 *
 * Two link shapes are in circulation:
 *   /s/1AbCdEf                -> shorturl `1AbCdEf`
 *   /sharing/link?surl=AbCdEf -> shorturl `1AbCdEf` (the prefix is implied)
 *
 * Normalising to one form is why `shareIdVariants` exists below: a handful of
 * shares only answer to the unprefixed id, so both get tried.
 */
export function extractShareId(url: URL): string | null {
  const fromQuery = url.searchParams.get("surl");
  if (fromQuery) return fromQuery.startsWith("1") ? fromQuery : `1${fromQuery}`;

  const match = /\/s\/([A-Za-z0-9_-]+)/.exec(url.pathname);
  const token = match?.[1];
  if (!token) return null;
  return token.startsWith("1") ? token : `1${token}`;
}

/** Both forms of the share id, canonical first. */
export function shareIdVariants(shareId: string): string[] {
  const stripped = shareId.startsWith("1") ? shareId.slice(1) : shareId;
  return stripped === shareId ? [shareId] : [shareId, stripped];
}

/** Share passwords are short codes; reject anything else early. */
export function parsePassword(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") throw ApiError.invalidParameter("password", "must be a string.");

  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > 32)
    throw ApiError.invalidParameter("password", "longer than 32 characters.");
  return trimmed;
}

/**
 * Cache key for a share. Share links carry wildly varying query strings
 * (tracking params, locale, referrer), so the key is built from the share id
 * and whether a password was used — never the raw URL.
 */
export function shareCacheKey(shareId: string, password?: string): string {
  return `share:v2:${shareId}:${password ? "pw" : "nopw"}`;
}
