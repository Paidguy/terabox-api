const REDACTED = "[redacted]";

/**
 * Keys whose values must never reach a log line.
 *
 * Cookies and download links are the whole security story of this worker, and
 * the Cloudflare observability tail is readable by anyone with dashboard
 * access. Redaction lives here, centrally, rather than depending on every
 * call site remembering.
 */
const SENSITIVE_KEY = /cookie|token|secret|password|authorization|key|ndus|randsk|dlink|sign/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return REDACTED;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(val, depth + 1);
  }
  return out;
}

/**
 * Emit one line of JSON, which is what `wrangler tail --format json` and
 * Workers Logpush expect.
 */
export function log(
  level: "info" | "warn" | "error",
  message: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(redact(fields) as Record<string, unknown>),
  });

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
