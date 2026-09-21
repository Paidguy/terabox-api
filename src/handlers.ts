import { Budget } from "./lib/budget";
import { dropCachedShare, getCachedShare, putCachedShare } from "./lib/cache";
import { cookieAt, cookiePool, pickCookie, pickCookieSlot, withUnlockKey } from "./lib/cookies";
import { ApiError, ErrorCode } from "./lib/errors";
import { contentDisposition, isInlinePlayable } from "./lib/format";
import { looksLikePlaylist, normalizeQuality, rewritePlaylist } from "./lib/hls";
import { htmlResponse, jsonResponse } from "./lib/http";
import { log } from "./lib/log";
import { mintSegmentToken, readSegmentClaims } from "./lib/sign";
import {
  DOWNLOAD_HEADERS,
  freshDownloadLink,
  hasSignature,
  hydrateShare,
  resolveShare,
  selectFile,
  streamingManifestUrl,
} from "./lib/terabox";
import {
  extractShareId,
  isAllowedDownloadUrl,
  parsePassword,
  parseShareLink,
  shareCacheKey,
} from "./lib/validate";
import { openApiSpec } from "./openapi";
import { landingPage } from "./ui/landing";
import type { Env, TeraboxFile, TeraboxShare } from "./types";

/** Batch size is bounded by the subrequest budget, not by taste. */
const MAX_BATCH = 8;
const BATCH_CONCURRENCY = 2;

export interface RequestContext {
  request: Request;
  env: Env;
  url: URL;
  requestId: string;
  budget: Budget;
}

interface Params {
  link: unknown;
  password: unknown;
  fsId: string | null;
}

/**
 * An `fs_id` in a JSON body may arrive as a string or as a number. Silently
 * ignoring the number would return the share's *first* file instead of the
 * one asked for, which is far worse than an error.
 */
function parseFsId(raw: unknown): string | null {
  if (typeof raw === "string" && raw !== "") return raw;
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return String(raw);
  return null;
}

/** Read parameters from a query string, a JSON body, or a form body. */
async function readParams(request: Request, url: URL): Promise<Params> {
  if (request.method === "POST") {
    const contentType = request.headers.get("Content-Type") ?? "";

    if (contentType.includes("application/json")) {
      const body = (await request.json().catch(() => {
        throw ApiError.invalidParameter("body", "not valid JSON.");
      })) as Record<string, unknown>;
      return {
        link: body["link"] ?? body["url"],
        password: body["password"] ?? body["pwd"],
        fsId: parseFsId(body["fs_id"]),
      };
    }

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const form = new URLSearchParams(await request.text());
      return {
        link: form.get("link") ?? form.get("url"),
        password: form.get("password") ?? form.get("pwd"),
        fsId: form.get("fs_id"),
      };
    }
  }

  return {
    link: url.searchParams.get("link") ?? url.searchParams.get("url"),
    password: url.searchParams.get("password") ?? url.searchParams.get("pwd"),
    fsId: url.searchParams.get("fs_id"),
  };
}

interface Resolved {
  /** Replaced in place if the share's signature is filled in after the fact. */
  share: TeraboxShare;
  cached: boolean;
  cacheKey: string;
  cookie: string;
  link: string;
  /** Carried so a re-resolve after an expired dlink can unlock the share again. */
  password: string | undefined;
}

/**
 * Resolve a share, consulting the cache first.
 *
 * Password-unlocked shares are cached under a distinct key so an unlocked
 * listing is never handed to a caller who didn't supply the password.
 */
async function resolveCached(
  ctx: RequestContext,
  rawLink: unknown,
  password: string | undefined,
  options: { force?: boolean } = {},
): Promise<Resolved> {
  const parsed = parseShareLink(rawLink);
  const link = parsed.toString();
  const picked = pickCookieSlot(ctx.env);
  const shareId = extractShareId(parsed);
  const cacheKey = shareCacheKey(shareId ?? link, password);

  if (!options.force) {
    const hit = await getCachedShare(ctx.env, cacheKey);
    if (hit) {
      // Signed download links belong to the account that requested them, so a
      // cache hit has to keep using that account, not whichever one the
      // rotation happened to pick this time.
      const cookie = cookieAt(ctx.env, hit.cookieSlot) ?? picked.cookie;
      return { share: hit, cached: true, cacheKey, cookie, link, password };
    }
  }

  const resolvedShare = await resolveShare(link, picked.cookie, ctx.budget, { password });
  const share: TeraboxShare = { ...resolvedShare, cookieSlot: picked.slot };
  const cookie = picked.cookie;
  await putCachedShare(ctx.env, cacheKey, share);

  log("info", "resolved share", {
    request_id: ctx.requestId,
    share_id: share.shareId,
    strategy: share.strategy,
    file_count: share.files.length,
    budget_used: ctx.budget.used,
  });

  return { share, cached: false, cacheKey, cookie, link, password };
}

function fileUrl(
  origin: string,
  path: string,
  link: string,
  file: TeraboxFile,
  extra: Record<string, string> = {},
): string {
  const params = new URLSearchParams({ link });
  if (file.fsId) params.set("fs_id", file.fsId);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return `${origin}${path}?${params}`;
}

function serializeFile(origin: string, link: string, share: TeraboxShare, file: TeraboxFile) {
  const canStreamHls = file.category === "video" && Boolean(share.shareNumericId && share.sign);

  return {
    fs_id: file.fsId,
    file_name: file.fileName,
    path: file.path,
    file_size: file.fileSize,
    size_bytes: file.sizeBytes,
    category: file.category,
    mime_type: file.mimeType,
    md5: file.md5,
    thumbnail: file.thumbnail,
    modified_at: file.modifiedAt,
    stream_url: fileUrl(origin, "/stream", link, file),
    download_url: fileUrl(origin, "/stream", link, file, { download: "1" }),
    hls_url: canStreamHls ? fileUrl(origin, "/hls", link, file) : null,
  };
}

function serializeShare(origin: string, resolved: Resolved) {
  const { share, link, cached } = resolved;
  const files = share.files.map((file) => serializeFile(origin, link, share, file));
  const primary = files[0]!;

  return {
    status: "success" as const,
    cached,
    url: link,
    share: {
      id: share.shareId,
      share_id: share.shareNumericId,
      uk: share.uk,
      resolved_url: share.resolvedUrl,
      password_protected: share.passwordProtected,
      file_count: files.length,
      truncated: share.truncated,
      strategy: share.strategy,
    },
    files,
    // Flat aliases for the first file, so v1.x clients reading `file_name` or
    // `stream_url` off the top level keep working unchanged.
    file_name: primary.file_name,
    file_size: primary.file_size,
    size_bytes: primary.size_bytes,
    thumbnail: primary.thumbnail,
    stream_url: primary.stream_url,
  };
}

/** `GET|POST /api/resolve` — and `GET /?link=` for v1 compatibility. */
export async function handleResolve(ctx: RequestContext): Promise<Response> {
  const { link, password, fsId } = await readParams(ctx.request, ctx.url);
  const resolved = await resolveCached(ctx, link, parsePassword(password));
  const payload = serializeShare(ctx.url.origin, resolved);

  if (!fsId) return jsonResponse(payload);

  const file = selectFile(resolved.share, fsId);
  const selected = serializeFile(ctx.url.origin, resolved.link, resolved.share, file);
  return jsonResponse({
    ...payload,
    files: [selected],
    file_name: selected.file_name,
    file_size: selected.file_size,
    size_bytes: selected.size_bytes,
    thumbnail: selected.thumbnail,
    stream_url: selected.stream_url,
  });
}

/**
 * `POST /api/batch` — resolve several links in one round trip.
 *
 * Bounded concurrency, and one bad link never fails the batch: each entry
 * reports its own status so a client can retry only the failures.
 */
export async function handleBatch(ctx: RequestContext): Promise<Response> {
  const body = (await ctx.request.json().catch(() => {
    throw ApiError.invalidParameter("body", "not valid JSON.");
  })) as { links?: unknown; password?: unknown };

  if (!Array.isArray(body.links)) {
    throw ApiError.invalidParameter("links", "must be an array of share URLs.");
  }

  const links: unknown[] = body.links;
  if (links.length === 0)
    throw ApiError.invalidParameter("links", "must contain at least one URL.");
  if (links.length > MAX_BATCH) {
    throw ApiError.invalidParameter("links", `at most ${MAX_BATCH} URLs per batch.`);
  }

  const password = parsePassword(body.password);
  const origin = ctx.url.origin;
  const results: unknown[] = new Array(links.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= links.length) return;
      const raw = links[index];

      try {
        const resolved = await resolveCached(ctx, raw, password);
        results[index] = serializeShare(origin, resolved);
      } catch (err) {
        const apiError =
          err instanceof ApiError
            ? err
            : new ApiError(ErrorCode.INTERNAL, "Unexpected error resolving this link.", 500);
        results[index] = {
          status: "error",
          url: typeof raw === "string" ? raw : null,
          error: { code: apiError.code, message: apiError.message },
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, links.length) }, worker));

  const succeeded = results.filter(
    (entry) => (entry as { status?: string }).status === "success",
  ).length;

  return jsonResponse({
    status: "success",
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  });
}

/**
 * Make sure a resolved share carries its signature, fetching it if it doesn't.
 *
 * Fresh resolves already do this, so this mostly matters for cache entries that
 * were stored unsigned. Without it such an entry would keep failing until it
 * expired, since nothing else re-checks. A successful lookup is written back so
 * the next request skips it.
 */
async function ensureSigned(ctx: RequestContext, resolved: Resolved): Promise<TeraboxShare> {
  if (hasSignature(resolved.share)) return resolved.share;

  const hydrated = await hydrateShare(resolved.share, resolved.cookie, ctx.budget);
  if (hasSignature(hydrated)) {
    resolved.share = hydrated;
    await putCachedShare(ctx.env, resolved.cacheKey, hydrated);
  }
  return hydrated;
}

/** Fetch the file bytes, minting a fresh dlink if the stored one is dead. */
async function openUpstream(
  ctx: RequestContext,
  resolved: Resolved,
  file: TeraboxFile,
  range: string | null,
): Promise<Response> {
  // Built per attempt, from the share that attempt's link came from. The retry
  // below re-resolves, possibly under a different account, and a link fetched
  // with the wrong account's cookie is refused.
  const attempt = async (url: string, from: Resolved): Promise<Response> => {
    const headers: Record<string, string> = {
      ...DOWNLOAD_HEADERS,
      Cookie: withUnlockKey(from.cookie, from.share.randsk),
      Referer: from.share.resolvedUrl,
    };
    if (range) headers["Range"] = range;

    return ctx.budget.fetch(url, {
      headers,
      method: ctx.request.method === "HEAD" ? "HEAD" : "GET",
      redirect: "follow",
      timeoutMs: 30_000,
      retries: 0,
    });
  };

  let link = file.downloadLink;
  if (!link) {
    const share = await ensureSigned(ctx, resolved);
    link = await freshDownloadLink(share, file, resolved.cookie, ctx.budget);
  }
  if (!isAllowedDownloadUrl(link)) {
    throw new ApiError(
      ErrorCode.UPSTREAM_UNEXPECTED,
      "Refusing to proxy an unexpected download host.",
      502,
    );
  }

  const first = await attempt(link, resolved);
  if (first.ok || first.status === 206) return first;

  // TeraBox dlinks are short-lived. A 403/410 here almost always means the
  // cached link aged out rather than that the file is gone — so drop the
  // cache entry, re-resolve, and try once with a freshly signed URL.
  const expired = first.status === 403 || first.status === 410;
  if (!expired || !ctx.budget.canAfford(3)) {
    throw ApiError.upstream(`Upstream fetch failed (status ${first.status}).`, {
      status: first.status,
    });
  }

  log("warn", "dlink expired, re-resolving", {
    request_id: ctx.requestId,
    status: first.status,
    share_id: resolved.share.shareId,
  });

  await dropCachedShare(ctx.env, resolved.cacheKey);
  const fresh = await resolveCached(ctx, resolved.link, resolved.password, { force: true });
  const freshFile = selectFile(fresh.share, file.fsId || null);

  let freshLink = freshFile.downloadLink;
  if (!freshLink) {
    const share = await ensureSigned(ctx, fresh);
    freshLink = await freshDownloadLink(share, freshFile, fresh.cookie, ctx.budget);
  }

  if (!isAllowedDownloadUrl(freshLink)) {
    throw new ApiError(
      ErrorCode.UPSTREAM_UNEXPECTED,
      "Refusing to proxy an unexpected download host.",
      502,
    );
  }

  const second = await attempt(freshLink, fresh);
  if (second.ok || second.status === 206) return second;
  throw ApiError.upstream(`Upstream fetch failed (status ${second.status}).`, {
    status: second.status,
  });
}

/**
 * `GET|HEAD /stream` — proxy the file bytes.
 *
 * Takes the original share link, never a download URL: the real dlink is
 * re-derived server-side every time, so this cannot become an open proxy.
 * Range requests pass straight through, which is what makes seeking and
 * resumable downloads work.
 */
export async function handleStream(ctx: RequestContext): Promise<Response> {
  const { link, password, fsId } = await readParams(ctx.request, ctx.url);
  const resolved = await resolveCached(ctx, link, parsePassword(password));
  const file = selectFile(resolved.share, fsId);

  const range = ctx.request.headers.get("Range");
  const upstream = await openUpstream(ctx, resolved, file, range);

  const wantsDownload =
    ctx.url.searchParams.get("download") === "1" || !isInlinePlayable(file.mimeType);

  const headers = new Headers({
    // Bytes fetched with our account credentials must not sit in a shared
    // cache, hence `private`.
    "Cache-Control": "private, max-age=3600",
    "Content-Type": file.mimeType,
    "Content-Disposition": contentDisposition(file.fileName, wantsDownload),
    "Accept-Ranges": "bytes",
    "X-Request-Id": ctx.requestId,
  });

  for (const header of ["Content-Range", "Content-Length", "ETag", "Last-Modified"]) {
    const value = upstream.headers.get(header);
    if (value) headers.set(header, value);
  }
  if (!headers.has("Content-Length") && !range && file.sizeBytes > 0) {
    headers.set("Content-Length", String(file.sizeBytes));
  }

  const body = ctx.request.method === "HEAD" ? null : upstream.body;
  return new Response(body, { status: upstream.status, headers });
}

/**
 * `GET /hls` — TeraBox's adaptive manifest, rewritten to route through here.
 *
 * Byte-range proxying only plays containers a browser understands natively;
 * MKV and AVI don't qualify. HLS is how TeraBox itself streams those, so this
 * endpoint is what makes "play anything in a browser" actually true.
 */
export async function handleHls(ctx: RequestContext): Promise<Response> {
  const { link, password, fsId } = await readParams(ctx.request, ctx.url);
  const resolved = await resolveCached(ctx, link, parsePassword(password));
  const file = selectFile(resolved.share, fsId);

  if (file.category !== "video") {
    throw ApiError.invalidParameter("fs_id", "HLS streaming is only available for video files.");
  }
  const share = await ensureSigned(ctx, resolved);
  if (!hasSignature(share)) {
    throw ApiError.upstreamUnexpected(
      "This share did not expose the signature needed for HLS streaming. Use 'stream_url' instead.",
    );
  }

  const quality = normalizeQuality(ctx.url.searchParams.get("quality"));
  const manifestUrl = streamingManifestUrl(share, file, quality);

  const response = await ctx.budget.fetch(manifestUrl, {
    headers: {
      ...DOWNLOAD_HEADERS,
      Accept: "*/*",
      Cookie: withUnlockKey(resolved.cookie, resolved.share.randsk),
      Referer: resolved.share.resolvedUrl,
    },
  });

  const body = await response.text();
  if (!response.ok || !looksLikePlaylist(body)) {
    log("warn", "hls manifest unavailable", {
      request_id: ctx.requestId,
      status: response.status,
      quality,
    });
    throw ApiError.upstream(
      "TeraBox did not return a playable manifest for this file. It may still be transcoding, or streaming may not be available for this share.",
      { status: response.status },
    );
  }

  const rewritten = await rewritePlaylist(body, manifestUrl, ctx.url.origin, (url) =>
    mintSegmentToken(ctx.env, url, share.cookieSlot),
  );

  return new Response(rewritten, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "private, max-age=300",
      "X-Request-Id": ctx.requestId,
    },
  });
}

/**
 * `GET /segment` — proxy one HLS segment or encryption key.
 *
 * Only accepts URLs this worker signed in `/hls`, which is the difference
 * between a media proxy and an open proxy.
 */
export async function handleSegment(ctx: RequestContext): Promise<Response> {
  const token = ctx.url.searchParams.get("t");
  if (!token) throw ApiError.missingParameter("t");

  const { url: target, slot } = await readSegmentClaims(ctx.env, token);
  if (!isAllowedDownloadUrl(target)) {
    throw new ApiError(
      ErrorCode.UPSTREAM_UNEXPECTED,
      "Refusing to proxy an unexpected segment host.",
      502,
    );
  }

  const headers: Record<string, string> = {
    ...DOWNLOAD_HEADERS,
    // The account that fetched the manifest, so the segments load for the same
    // one; any account when the token predates slot tracking.
    Cookie: cookieAt(ctx.env, slot) ?? pickCookie(ctx.env),
  };
  const range = ctx.request.headers.get("Range");
  if (range) headers["Range"] = range;

  const upstream = await ctx.budget.fetch(target, { headers, redirect: "follow", retries: 0 });
  if (!upstream.ok && upstream.status !== 206) {
    throw ApiError.upstream(`Segment fetch failed (status ${upstream.status}).`, {
      status: upstream.status,
    });
  }

  const responseHeaders = new Headers({
    "Content-Type": upstream.headers.get("Content-Type") ?? "video/mp2t",
    "Cache-Control": "private, max-age=3600",
    "Accept-Ranges": "bytes",
  });
  for (const header of ["Content-Range", "Content-Length"]) {
    const value = upstream.headers.get(header);
    if (value) responseHeaders.set(header, value);
  }

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

/** `GET /health` — liveness plus a config summary, with no secrets in it. */
export function handleHealth(ctx: RequestContext): Response {
  const pool = cookiePool(ctx.env);

  return jsonResponse({
    status: "ok",
    version: "2.0.3",
    timestamp: new Date().toISOString(),
    config: {
      cookies_configured: pool.length,
      auth_required: Boolean(ctx.env.API_KEY),
      kv_cache: Boolean(ctx.env.CACHE),
      rate_limit: ctx.env.RATE_LIMIT ?? "30",
      rate_limit_window: ctx.env.RATE_LIMIT_WINDOW ?? "60",
    },
  });
}

export function handleOpenApi(ctx: RequestContext): Response {
  return jsonResponse(openApiSpec(ctx.url.origin));
}

export function handleLanding(ctx: RequestContext): Response {
  return htmlResponse(landingPage(ctx.url.origin, Boolean(ctx.env.API_KEY)));
}
