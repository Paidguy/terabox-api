import {
  handleBatch,
  handleHealth,
  handleHls,
  handleLanding,
  handleOpenApi,
  handleResolve,
  handleSegment,
  handleStream,
  type RequestContext,
} from "./handlers";
import { Budget } from "./lib/budget";
import { ApiError, ErrorCode } from "./lib/errors";
import { CORS_HEADERS, clientIp, errorResponse, newRequestId, withHeaders } from "./lib/http";
import { log } from "./lib/log";
import { checkRateLimit, rateLimitHeaders } from "./lib/ratelimit";
import type { Env } from "./types";

/** Endpoints that stay open even when API_KEY is configured. */
const PUBLIC_PATHS = new Set(["/", "/health", "/openapi.json", "/favicon.ico"]);

/** Endpoints that hit TeraBox, and are therefore rate limited. */
const METERED_PATHS = new Set(["/api/resolve", "/api/batch", "/stream", "/hls", "/segment"]);

/**
 * Constant-time comparison, so a caller can't recover the API key by timing
 * how long a wrong guess takes to be rejected.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * `GET /` with no link is the docs page. Any other request to `/` is the v1
 * compatibility resolver, which spends the TeraBox account like any other
 * resolve — so it is neither public nor exempt from rate limiting.
 */
function isLandingRequest(request: Request, url: URL): boolean {
  return (
    url.pathname === "/" &&
    request.method === "GET" &&
    !url.searchParams.has("link") &&
    !url.searchParams.has("url")
  );
}

function authorize(request: Request, url: URL, env: Env): void {
  const configured = env.API_KEY?.trim();
  if (!configured) return;
  if (url.pathname === "/" ? isLandingRequest(request, url) : PUBLIC_PATHS.has(url.pathname)) {
    return;
  }

  const header = request.headers.get("Authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const provided = bearer || url.searchParams.get("key") || "";

  if (!provided || !safeEqual(provided, configured)) throw ApiError.unauthorized();
}

function route(ctx: RequestContext): Promise<Response> | Response | null {
  const { request, url } = ctx;
  const { pathname } = url;
  const method = request.method;

  // v1 compatibility: `GET /?link=` and `POST /` resolved a share before the
  // /api/* routes existed. Both still work; a bare `GET /` is the docs page.
  if (pathname === "/") {
    if (method === "POST") return handleResolve(ctx);
    if (method === "GET") {
      return url.searchParams.has("link") || url.searchParams.has("url")
        ? handleResolve(ctx)
        : handleLanding(ctx);
    }
    return null;
  }

  if (pathname === "/api/resolve" && (method === "GET" || method === "POST")) {
    return handleResolve(ctx);
  }
  if (pathname === "/api/batch" && method === "POST") return handleBatch(ctx);
  if (pathname === "/stream" && (method === "GET" || method === "HEAD")) return handleStream(ctx);
  if (pathname === "/hls" && method === "GET") return handleHls(ctx);
  if (pathname === "/segment" && (method === "GET" || method === "HEAD")) return handleSegment(ctx);
  if (pathname === "/health" && method === "GET") return handleHealth(ctx);
  if (pathname === "/openapi.json" && method === "GET") return handleOpenApi(ctx);
  if (pathname === "/favicon.ico") return new Response(null, { status: 204 });

  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const requestId = newRequestId();

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const started = Date.now();
    const ctx: RequestContext = { request, env, url, requestId, budget: new Budget() };
    let extraHeaders: Record<string, string> = {};

    try {
      authorize(request, url, env);

      const metered =
        METERED_PATHS.has(url.pathname) ||
        (url.pathname === "/" && !isLandingRequest(request, url));

      if (metered) {
        const limit = checkRateLimit(env, clientIp(request));
        extraHeaders = rateLimitHeaders(limit);
        if (!limit.allowed) throw ApiError.rateLimited(limit.retryAfter);
      }

      const routed = route(ctx);
      if (routed === null) {
        throw new ApiError(
          ErrorCode.NOT_FOUND,
          `No route for ${request.method} ${url.pathname}. See ${url.origin}/openapi.json.`,
          404,
        );
      }

      const response = await routed;
      log("info", "request complete", {
        request_id: requestId,
        method: request.method,
        path: url.pathname,
        status: response.status,
        duration_ms: Date.now() - started,
        budget_used: ctx.budget.used,
      });

      return withHeaders(response, { ...CORS_HEADERS, ...extraHeaders, "X-Request-Id": requestId });
    } catch (err) {
      if (err instanceof ApiError) {
        log("warn", "request failed", {
          request_id: requestId,
          method: request.method,
          path: url.pathname,
          code: err.code,
          status: err.status,
          duration_ms: Date.now() - started,
        });
      } else {
        // Unexpected errors are logged in full but never echoed to the caller,
        // since their messages can leak internals.
        log("error", "unhandled error", {
          request_id: requestId,
          method: request.method,
          path: url.pathname,
          error: err instanceof Error ? err.stack : String(err),
        });
      }

      return withHeaders(errorResponse(err, requestId), { ...CORS_HEADERS, ...extraHeaders });
    }
  },
} satisfies ExportedHandler<Env>;
