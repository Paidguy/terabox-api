/**
 * Cloudflare Worker environment bindings.
 *
 * Only TERABOX_COOKIE is required. Everything else is optional with a working
 * default, so a bare `wrangler deploy` plus one secret gets you a live API.
 */
export interface Env {
  /**
   * TeraBox session cookie(s). Either `ndus=VALUE` or just `VALUE`.
   * Separate several accounts with commas to rotate between them.
   */
  TERABOX_COOKIE: string;

  /**
   * Optional. When set, every API request must send
   * `Authorization: Bearer <key>` (or `?key=<key>`).
   */
  API_KEY?: string;

  /** Optional KV namespace. Without it the cache is per-isolate memory. */
  CACHE?: KVNamespace;

  /** Optional. Cache TTL in seconds for resolved shares. Default 1800. */
  CACHE_TTL?: string;
  /** Optional. Requests per IP per window. `0` disables. Default 30. */
  RATE_LIMIT?: string;
  /** Optional. Rate limit window in seconds. Default 60. */
  RATE_LIMIT_WINDOW?: string;
}

/** Broad file class, matching the category value TeraBox returns. */
export type FileCategory = "video" | "audio" | "image" | "document" | "application" | "other";

/** One file inside a share. */
export interface TeraboxFile {
  /** TeraBox's stable file id — used to select this file out of a folder. */
  fsId: string;
  fileName: string;
  /** Path inside the share, e.g. `/Season 1/ep01.mkv`. */
  path: string;
  /** Direct TeraBox CDN URL. Short-lived and cookie-bound; never exposed. */
  downloadLink: string;
  thumbnail: string;
  fileSize: string;
  sizeBytes: number;
  md5: string;
  category: FileCategory;
  mimeType: string;
  /** Unix seconds, when TeraBox reports it. */
  modifiedAt: number | null;
}

/** A resolved share link. */
export interface TeraboxShare {
  /** The short share id (surl) from the link. */
  shareId: string;
  /** TeraBox's numeric share id, needed for streaming and fresh dlinks. */
  shareNumericId: string;
  /** Owner user key, needed alongside shareNumericId. */
  uk: string;
  /** Signature pair from the share record, needed for streaming/download. */
  sign: string;
  timestamp: string;
  /** Unlock key for password-protected shares, when one was used. */
  randsk: string;
  /** The share page token, when a strategy managed to extract one. */
  jsToken: string;
  /** Origin the share finally resolved to, e.g. `https://www.terabox.com`. */
  origin: string;
  /** The URL the share link finally redirected to. */
  resolvedUrl: string;
  files: TeraboxFile[];
  passwordProtected: boolean;
  /** True when the file cap was hit and some entries were left out. */
  truncated: boolean;
  /** Which resolution strategy produced this result. */
  strategy: "signed" | "anonymous" | "wap";
  /**
   * Position in the `TERABOX_COOKIE` pool of the account that resolved this
   * share. Signed download links only work for that account, so anything
   * served from the cache must keep using it. Absent on entries that predate
   * this field.
   */
  cookieSlot?: number;
}
