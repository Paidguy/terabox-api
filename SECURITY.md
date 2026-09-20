# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities. Instead,
use GitHub's [private vulnerability reporting](../../security/advisories/new)
for this repository, or open an issue asking for a private contact channel if
that isn't enabled.

Include:

- What you found and why it's exploitable
- Steps to reproduce (with a redacted/dummy cookie and link — never a real one)
- Impact you'd expect in a typical deployment

## Scope and design notes for reviewers

This worker has two endpoints that fetch content on the caller's behalf —
`/stream` and `/segment` — and both are deliberately designed so that a
caller can never control the destination URL:

- **`/stream`** takes a share _link_, never a download URL. The actual
  TeraBox CDN URL (`dlink`) is derived server-side, fresh, on every request
  (`resolveShare` / `freshDownloadLink` in `src/lib/terabox.ts`), and is
  additionally checked against `isAllowedDownloadUrl` in
  `src/lib/validate.ts` before being fetched. This closes the classic
  open-proxy / SSRF pattern common in similar tools that accept `?url=`
  directly.
- **`/segment`** (used by the HLS pipeline) takes a signed, short-lived
  token — never a URL at all. Tokens are minted server-side in
  `/hls` (`src/lib/sign.ts::mintSegmentToken`), HMAC-signed with a key
  derived from the worker's own secrets, and verified before use
  (`readSegmentToken`). A forged or tampered token is rejected with `403`
  regardless of what URL it claims to authorise. Rotating
  `TERABOX_COOKIE` or `API_KEY` invalidates every outstanding token as a
  side effect, since the signing key is derived from both.

Beyond that, this worker deliberately does **not**:

- Fetch any share link whose host isn't in the allowlist in
  `src/lib/validate.ts` (`SHARE_DOMAINS`) — checked _before_ any request is
  made, so an attacker-supplied host is rejected without ever being
  contacted.
- Log the TeraBox cookie, API key, download links, signatures, or unlock
  keys — `src/lib/log.ts` redacts every field matching a sensitive-key
  pattern before a line is ever written, recursively through nested objects.
- Echo raw exception messages or stack traces to the client on an
  unexpected error — those are logged server-side only
  (`src/index.ts`'s catch block), and the client gets a generic `internal`
  error code instead.
- Hardcode a cookie or pull one from a third-party endpoint. It's read only
  from the `TERABOX_COOKIE` secret binding, optionally as a comma-separated
  pool for rotation across your own accounts (`src/lib/cookies.ts`).
- Compare API keys with a naive `===`, which would leak timing information
  about how many leading characters were correct. `src/index.ts::safeEqual`
  does a constant-time comparison instead.

If you find a way around any of the above, that's exactly the kind of report
this policy is for.

## Supported versions

This is a single-branch project; only the latest commit on `main` is
supported. There are no maintained older versions.
