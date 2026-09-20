import type { FileCategory } from "../types";

const UNITS = ["Bytes", "KB", "MB", "GB", "TB", "PB"] as const;

/** Format a byte count, e.g. `1536` -> `"1.5 KB"`. */
export function formatBytes(bytes: number | string): string {
  const value = toBytes(bytes);
  if (!value || Number.isNaN(value) || value <= 0) return "0 Bytes";

  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), UNITS.length - 1);
  const size = value / Math.pow(1024, exponent);
  return `${parseFloat(size.toFixed(2))} ${UNITS[exponent]}`;
}

/** Coerce TeraBox's string-or-number numeric fields to a safe integer. */
export function toBytes(bytes: number | string | undefined | null): number {
  if (typeof bytes === "number") return Number.isFinite(bytes) ? Math.max(0, Math.trunc(bytes)) : 0;
  if (typeof bytes === "string") {
    const parsed = parseInt(bytes, 10);
    return Number.isNaN(parsed) ? 0 : Math.max(0, parsed);
  }
  return 0;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mkv: "video/x-matroska",
  webm: "video/webm",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  flv: "video/x-flv",
  wmv: "video/x-ms-wmv",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
  "3gp": "video/3gpp",
  ts: "video/mp2t",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/opus",
  wma: "audio/x-ms-wma",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  heic: "image/heic",
  pdf: "application/pdf",
  epub: "application/epub+zip",
  txt: "text/plain",
  srt: "text/plain",
  ass: "text/plain",
  vtt: "text/vtt",
  json: "application/json",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  tar: "application/x-tar",
  gz: "application/gzip",
  apk: "application/vnd.android.package-archive",
  exe: "application/vnd.microsoft.portable-executable",
  iso: "application/x-iso9660-image",
};

export function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot === -1 || dot === fileName.length - 1) return "";
  return fileName.slice(dot + 1).toLowerCase();
}

/**
 * Guess a MIME type from the file name.
 *
 * TeraBox's CDN commonly serves `application/octet-stream`, which stops a
 * browser playing video or audio inline. Inferring from the extension is what
 * makes `<video src="/stream?...">` work at all.
 */
export function guessMimeType(fileName: string): string {
  return MIME_BY_EXTENSION[fileExtension(fileName)] ?? "application/octet-stream";
}

/** TeraBox's own `category` field, when present. */
const CATEGORY_BY_CODE: Record<number, FileCategory> = {
  1: "video",
  2: "audio",
  3: "image",
  4: "document",
  5: "application",
  6: "other",
};

export function categoryOf(fileName: string, code?: number | string): FileCategory {
  const numeric = toBytes(code);
  const fromCode = CATEGORY_BY_CODE[numeric];
  if (fromCode) return fromCode;

  const mime = guessMimeType(fileName);
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("text/") || mime === "application/pdf" || mime.includes("officedocument")) {
    return "document";
  }
  if (mime === "application/octet-stream") return "other";
  return "application";
}

/** True for types a browser can usually play or render inline. */
export function isInlinePlayable(mimeType: string): boolean {
  return (
    mimeType.startsWith("video/") ||
    mimeType.startsWith("audio/") ||
    mimeType.startsWith("image/") ||
    mimeType === "application/pdf" ||
    mimeType.startsWith("text/")
  );
}

/**
 * Build a `Content-Disposition` that survives non-ASCII file names, using the
 * RFC 5987 `filename*` form with an ASCII fallback. TeraBox shares are full of
 * Hindi, Arabic and CJK file names, and a naive header mangles all of them.
 */
export function contentDisposition(fileName: string, attachment: boolean): string {
  const type = attachment ? "attachment" : "inline";
  const ascii = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  // encodeURIComponent leaves ' ( ) * alone, but RFC 5987 doesn't allow them
  // unescaped in filename*, and a stray ' breaks parsing in some browsers.
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
