/**
 * Machine-readable error codes — part of the public API contract.
 * Clients branch on `code`; `message` is for humans and may be reworded.
 */
export const ErrorCode = {
  MISSING_PARAMETER: "missing_parameter",
  INVALID_PARAMETER: "invalid_parameter",
  UNSUPPORTED_HOST: "unsupported_host",
  UNAUTHORIZED: "unauthorized",
  PASSWORD_REQUIRED: "password_required",
  EMPTY_SHARE: "empty_share",
  NOT_FOUND: "not_found",
  RATE_LIMITED: "rate_limited",
  /** TeraBox is demanding a CAPTCHA. Retryable, often from a different IP. */
  VERIFICATION_REQUIRED: "verification_required",
  COOKIE_INVALID: "cookie_invalid",
  /** Ran out of the per-request upstream call budget. */
  BUDGET_EXHAUSTED: "budget_exhausted",
  UPSTREAM_UNEXPECTED: "upstream_unexpected",
  UPSTREAM_UNAVAILABLE: "upstream_unavailable",
  INTERNAL: "internal",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export class ApiError extends Error {
  readonly code: ErrorCodeValue;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCodeValue,
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  static missingParameter(name: string): ApiError {
    return new ApiError(ErrorCode.MISSING_PARAMETER, `Missing required parameter '${name}'.`, 400, {
      parameter: name,
    });
  }

  static invalidParameter(name: string, reason: string): ApiError {
    return new ApiError(ErrorCode.INVALID_PARAMETER, `Invalid '${name}': ${reason}`, 400, {
      parameter: name,
    });
  }

  static unsupportedHost(host: string): ApiError {
    return new ApiError(
      ErrorCode.UNSUPPORTED_HOST,
      `'${host}' is not a recognised TeraBox domain.`,
      400,
      { host },
    );
  }

  static unauthorized(): ApiError {
    return new ApiError(
      ErrorCode.UNAUTHORIZED,
      "Missing or invalid API key. Send it as 'Authorization: Bearer <key>'.",
      401,
    );
  }

  static passwordRequired(message = "This share is password-protected. Retry with 'password'.") {
    return new ApiError(ErrorCode.PASSWORD_REQUIRED, message, 401);
  }

  static rateLimited(retryAfterSeconds: number): ApiError {
    return new ApiError(
      ErrorCode.RATE_LIMITED,
      `Rate limit exceeded. Retry in ${retryAfterSeconds}s.`,
      429,
      { retry_after: retryAfterSeconds },
    );
  }

  static notFound(message = "Not found."): ApiError {
    return new ApiError(ErrorCode.NOT_FOUND, message, 404);
  }

  static cookieInvalid(message: string): ApiError {
    return new ApiError(ErrorCode.COOKIE_INVALID, message, 502);
  }

  static verificationRequired(errno?: number): ApiError {
    return new ApiError(
      ErrorCode.VERIFICATION_REQUIRED,
      "TeraBox is asking for CAPTCHA verification on this request. This is usually temporary — retry shortly.",
      503,
      errno === undefined ? undefined : { errno },
    );
  }

  static budgetExhausted(): ApiError {
    return new ApiError(
      ErrorCode.BUDGET_EXHAUSTED,
      "Ran out of upstream request budget for this share. It is probably a very large folder — request a single file with 'fs_id'.",
      503,
    );
  }

  static upstream(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError(ErrorCode.UPSTREAM_UNAVAILABLE, message, 502, details);
  }

  static upstreamUnexpected(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError(ErrorCode.UPSTREAM_UNEXPECTED, message, 502, details);
  }
}

/** Errnos that mean the page token went stale — refresh it and try again. */
const STALE_TOKEN_ERRNOS = new Set([-6, 4000020, 400141, 460020]);
/** Errnos that mean TeraBox wants a CAPTCHA solved. */
const VERIFY_ERRNOS = new Set([400210, 460020]);
/** Errnos that mean the share is locked behind a password. */
const PASSWORD_ERRNOS = new Set([-9, -12, -21]);

export function isStaleTokenErrno(errno: number): boolean {
  return STALE_TOKEN_ERRNOS.has(errno);
}

export function isVerificationErrno(errno: number): boolean {
  return VERIFY_ERRNOS.has(errno);
}

export function isPasswordErrno(errno: number): boolean {
  return PASSWORD_ERRNOS.has(errno);
}

/**
 * Translate a TeraBox `errno` into an ApiError.
 *
 * The mapping matters more than it looks: a wrong mapping turns a
 * password-protected share into a misleading "not found", and turns a
 * temporary CAPTCHA wall into a permanent-looking failure. Unmapped codes
 * deliberately keep the errno in `details` and stay non-fatal so the caller
 * can fall through to another strategy or mirror.
 */
export function fromTeraboxErrno(errno: number, errmsg?: string): ApiError {
  if (isPasswordErrno(errno)) {
    return ApiError.passwordRequired(
      errno === -9
        ? "This share is password-protected. Retry with 'password'."
        : "That password was rejected by TeraBox.",
    );
  }
  if (isVerificationErrno(errno)) {
    return ApiError.verificationRequired(errno);
  }
  if (errno === 105 || errno === -3) {
    return ApiError.notFound("That share link doesn't exist or has been deleted.");
  }
  if (errno === 2) {
    return ApiError.upstreamUnexpected("TeraBox rejected the request parameters.", { errno });
  }
  if (errno === 31034) {
    return ApiError.upstream("TeraBox is rate-limiting this account. Wait a few minutes.", {
      errno,
    });
  }
  if (isStaleTokenErrno(errno)) {
    return ApiError.cookieInvalid(
      "TeraBox rejected the session token. The TERABOX_COOKIE secret may have expired.",
    );
  }
  return ApiError.upstream(errmsg ? `TeraBox error: ${errmsg}` : `TeraBox error ${errno}.`, {
    errno,
  });
}
