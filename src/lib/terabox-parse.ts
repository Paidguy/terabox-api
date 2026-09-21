import { categoryOf, formatBytes, guessMimeType, toBytes } from "./format";
import type { TeraboxFile } from "../types";

/** The raw shape of a file entry as TeraBox returns it. */
export interface RawFile {
  fs_id?: number | string;
  server_filename?: string;
  filename?: string;
  path?: string;
  dlink?: string;
  size?: string | number;
  isdir?: string | number;
  category?: string | number;
  md5?: string;
  server_mtime?: number | string;
  local_mtime?: number | string;
  thumbs?: { url1?: string; url2?: string; url3?: string; icon?: string };
}

export interface ShareRecord {
  shareNumericId: string;
  uk: string;
  sign: string;
  timestamp: string;
}

function firstMatch(haystack: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const found = pattern.exec(haystack);
    const value = found?.[1];
    if (value) return value;
  }
  return "";
}

/**
 * Extract the share page token.
 *
 * TeraBox has shipped at least four ways of embedding this and rotates
 * between them across A/B deployments, so several shapes are tried. The
 * percent-encoded `fn("...")` trampoline is the long-standing one; the
 * `templateData` forms show up on newer builds.
 */
export function extractJsToken(html: string): string {
  const encoded = firstMatch(html, [
    /fn%28%22([A-Fa-f0-9]{30,})%22%29/,
    /fn\(%22([A-Fa-f0-9]{30,})%22\)/,
  ]);
  if (encoded) return encoded;

  return firstMatch(html, [
    /fn\("([A-Fa-f0-9]{30,})"\)/,
    // The same trampoline once it has been JSON-embedded in a script tag, so
    // its quotes arrive backslash-escaped: fn(\"TOKEN\").
    /fn\(\\+["']([A-Fa-f0-9]{30,})\\*["']\)/,
    // ...and once percent-encoded on top of that: fn%28%5C%22TOKEN%5C%22%29.
    /fn%28%5C%22([A-Fa-f0-9]{30,})%5C%22%29/i,
    /"jsToken"\s*:\s*"([A-Fa-f0-9]{30,})"/,
    /jsToken\s*[=:]\s*["']([A-Fa-f0-9]{30,})["']/,
    /%22jsToken%22%3A%22([A-Fa-f0-9]{30,})%22/,
  ]);
}

/**
 * `dp-logid` is only used for TeraBox's own tracing. A synthetic value beats
 * failing the request when the page shape changes.
 */
export function makeLogId(): string {
  return Date.now().toString(16).padEnd(20, "0");
}

export function extractLogId(html: string): string {
  const found = firstMatch(html, [/dp-logid=([A-Za-z0-9_-]+)/, /"dp-logid"\s*:\s*"([^"]+)"/]);
  return found || makeLogId();
}

/** True when the page is a password gate rather than a file listing. */
export function looksPasswordProtected(html: string): boolean {
  return (
    /"share_type"\s*:\s*"?2/.test(html) ||
    /accessCode|access_code|pwd-?input|extraction[- ]code|verify-?form/i.test(html)
  );
}

/** True when TeraBox is serving its CAPTCHA wall instead of the share. */
export function looksVerificationWalled(html: string): boolean {
  return /need\s*verify_v2|verify_v2|captcha/i.test(html);
}

/**
 * Slice a balanced JSON object or array out of `source`, starting at `from`.
 * String-aware, so braces inside file names don't end the slice early.
 */
export function sliceBalanced(source: string, from: number): string | null {
  const open = source[from];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = from; i < source.length; i++) {
    const char = source[i]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  return null;
}

/**
 * Parse `window.__INITIAL_STATE__` out of a WAP share page.
 *
 * The mobile page embeds the whole share record — signed dlinks included —
 * in this blob, which is why it works even when the JSON APIs are walled.
 */
export function parseInitialState(html: string): unknown {
  const markers = ["window.__INITIAL_STATE__", "__INITIAL_STATE__", "window.__REDUX_STATE__"];

  for (const marker of markers) {
    const at = html.indexOf(marker);
    if (at === -1) continue;

    const eq = html.indexOf("=", at + marker.length);
    if (eq === -1) continue;

    const start = html.slice(eq + 1).search(/[[{]/);
    if (start === -1) continue;

    const raw = sliceBalanced(html, eq + 1 + start);
    if (!raw) continue;

    try {
      return JSON.parse(raw);
    } catch {
      continue;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeFile(value: unknown): value is RawFile {
  if (!isRecord(value)) return false;
  const hasName =
    typeof value["server_filename"] === "string" || typeof value["filename"] === "string";
  const hasId = value["fs_id"] !== undefined;
  return hasName && hasId;
}

/**
 * Walk an arbitrary object graph and collect every file-shaped entry.
 *
 * Deliberately shape-agnostic: the WAP payload has been restructured several
 * times, and a deep search for entries that *look* like files survives that
 * far better than hard-coding a path like `state.file_list.list`.
 */
export function collectRawFiles(value: unknown, depth = 0): RawFile[] {
  if (depth > 8 || value === null || typeof value !== "object") return [];

  if (Array.isArray(value)) {
    const direct = value.filter(looksLikeFile);
    if (direct.length > 0) return direct;
    return value.flatMap((item) => collectRawFiles(item, depth + 1));
  }

  if (looksLikeFile(value)) return [value];
  return Object.values(value).flatMap((item) => collectRawFiles(item, depth + 1));
}

/** Deep-search an object graph for the first usable value at any of `keys`. */
function deepFind(value: unknown, keys: string[], depth = 0): string {
  if (depth > 8 || value === null || typeof value !== "object") return "";

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFind(item, keys, depth + 1);
      if (found) return found;
    }
    return "";
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate !== "") return candidate;
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }

  for (const item of Object.values(record)) {
    const found = deepFind(item, keys, depth + 1);
    if (found) return found;
  }
  return "";
}

/**
 * Pull the share record identifiers out of a page or API payload.
 *
 * `shareid`/`uk` identify the share, and `sign`/`timestamp` are the signature
 * pair required by the streaming and fresh-dlink endpoints. Without them
 * `/hls` cannot be built at all.
 */
export function extractShareRecord(source: string | unknown): ShareRecord {
  const graph = typeof source === "string" ? parseInitialState(source) : source;

  const record: ShareRecord = {
    shareNumericId: deepFind(graph, ["shareid", "share_id", "shareId"]),
    uk: deepFind(graph, ["uk", "share_uk", "userId"]),
    sign: deepFind(graph, ["sign"]),
    timestamp: deepFind(graph, ["timestamp", "stamp"]),
  };

  if (typeof source !== "string") return record;

  // Fall back to inline script variables when there's no INITIAL_STATE blob.
  if (!record.shareNumericId) {
    record.shareNumericId = firstMatch(source, [
      /"shareid"\s*:\s*"?(\d+)"?/,
      /shareid\s*[=:]\s*["']?(\d+)["']?/,
    ]);
  }
  if (!record.uk) {
    record.uk = firstMatch(source, [/"uk"\s*:\s*"?(\d+)"?/, /\buk\s*[=:]\s*["']?(\d+)["']?/]);
  }
  if (!record.sign) {
    record.sign = firstMatch(source, [/"sign"\s*:\s*"([^"]+)"/]);
  }
  if (!record.timestamp) {
    record.timestamp = firstMatch(source, [/"timestamp"\s*:\s*"?(\d+)"?/]);
  }
  return record;
}

export function isDirectory(raw: RawFile): boolean {
  return raw.isdir === 1 || raw.isdir === "1";
}

/** Normalise a raw TeraBox entry into the shape this API returns. */
export function mapFile(raw: RawFile): TeraboxFile {
  const fileName =
    raw.server_filename || raw.filename || raw.path?.split("/").filter(Boolean).pop() || "download";
  const mtime = raw.server_mtime ?? raw.local_mtime;
  const modifiedAt = mtime === undefined ? null : toBytes(mtime) || null;

  return {
    fsId: raw.fs_id === undefined ? "" : String(raw.fs_id),
    fileName,
    path: raw.path || `/${fileName}`,
    downloadLink: raw.dlink || "",
    thumbnail: raw.thumbs?.url3 || raw.thumbs?.url2 || raw.thumbs?.url1 || raw.thumbs?.icon || "",
    fileSize: formatBytes(raw.size ?? 0),
    sizeBytes: toBytes(raw.size),
    md5: typeof raw.md5 === "string" ? raw.md5 : "",
    category: categoryOf(fileName, raw.category),
    mimeType: guessMimeType(fileName),
    modifiedAt,
  };
}
