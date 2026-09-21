import { ApiError, ErrorCode } from "./errors";

/**
 * CORS is wide open by design. A download/stream API is consumed cross-origin
 * by definition — from a browser player, a bookmarklet, a mobile app — and an
 * origin allowlist on a self-hosted worker just breaks those callers. Access
 * control belongs to API_KEY, not to the Origin header.
 */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,HEAD,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Range,Authorization",
  "Access-Control-Expose-Headers":
    "Content-Length,Content-Range,Accept-Ranges,X-Request-Id,X-RateLimit-Remaining,Retry-After",
  "Access-Control-Max-Age": "86400",
};

export function withHeaders(response: Response, extra: Record<string, string>): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}

/**
 * Every error uses one envelope:
 *
 *   { "status": "error", "error": { "code", "message", ... }, "request_id" }
 *
 * Clients branch on `error.code`; `message` is for humans.
 */
export function errorResponse(error: unknown, requestId: string): Response {
  const apiError =
    error instanceof ApiError
      ? error
      : new ApiError(ErrorCode.INTERNAL, "An unexpected error occurred.", 500);

  const headers: Record<string, string> = { "X-Request-Id": requestId };
  const retryAfter = apiError.details?.["retry_after"];
  if (typeof retryAfter === "number") headers["Retry-After"] = String(retryAfter);

  return jsonResponse(
    {
      status: "error",
      error: { code: apiError.code, message: apiError.message, ...(apiError.details ?? {}) },
      request_id: requestId,
    },
    apiError.status,
    headers,
  );
}

/** Best-effort client identity for rate limiting. */
export function clientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export function newRequestId(): string {
  return crypto.randomUUID();
}
