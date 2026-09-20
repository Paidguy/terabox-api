# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.0.2] - 2026-09-20

### Fixed

- **`/stream` and `hls_url` still failing with "did not expose the
  signature" after 2.0.1.** 2.0.1 added `/api/shorturlinfo` and the mobile
  page as signature fallbacks, but both require the page's `jsToken` to
  answer reliably and both are increasingly answering `errno 400210`
  ("need verify_v2") for shares resolved anonymously. `hydrateShare` now
  tries `/share/tplconfig?fields=sign,timestamp` first whenever `shareid`/
  `uk` are already known (the normal case for an anonymous listing): it's a
  single call that needs no `jsToken` and mints just the missing
  `sign`/`timestamp` pair, confirmed against how AList/OpenList's
  `baidu_share` driver resolves the same Baidu-lineage share API TeraBox is
  built on. `/api/shorturlinfo` and the mobile page remain as fallbacks when
  `tplconfig` doesn't answer either.

## [2.0.1] - 2026-09-20

### Fixed

- **`/stream` failing with "This share did not expose the signature needed to
  mint a fresh download link".** A share could list fine yet carry no
  `shareid` / `uk` / `sign` / `timestamp`: the share page is a client-rendered
  shell, `/share/list` doesn't repeat them, and the anonymous strategy threw
  away whatever the page did have. Resolution now looks the record up from
  `/api/shorturlinfo` (with and without the page token, across mirrors), then
  from the mobile page, whenever the listing came back unsigned. Cache entries
  stored unsigned are repaired on the next `/stream` or `/hls` instead of
  failing until they expire.
- **Downloads cut off after 30 seconds** (HLS segments after 15). The upstream
  timeout stayed armed after the response headers arrived and aborted the body
  mid-transfer. It now covers only the wait for headers.
- **Password-protected shares could never be unlocked**: the password gate was
  rejected before the supplied password was used.
- **`API_KEY` and rate limiting did not apply to the v1 root routes**
  (`GET /?link=…`, `POST /`), which resolved shares with your account cookie
  for anyone.
- **Cookie rotation**: a cached share is now always used with the account that
  resolved it, the post-expiry retry in `/stream` uses the re-resolved account's
  cookie rather than the original one, and `/segment` tokens carry the manifest's
  account.
- `/share/download` is retried in its GET form if the POST form yields no link,
  and accepts the response shapes seen in the wild (bare string, `list`, `info`).
- The WAP page is only treated as CAPTCHA-walled when it lists no files.
- A numeric `fs_id` in a JSON body is honoured instead of silently ignored.
- `Content-Disposition` percent-encodes `'`, `(`, `)` and `*` in `filename*`.
- `jsToken` is also found when the `fn("…")` trampoline is JSON- or
  percent-escaped.
- `/health` counts cookies the same way the resolver does.

### Removed

- The Vitest suite and its CI step.

## [2.0.0] - 2026-09-20

Rebuilt from the ground up after research into how comparable TeraBox
resolvers and commercial APIs actually work in practice — see
`docs/ARCHITECTURE.md` for the reasoning behind each change below.

### Added

- **Multi-strategy resolution**: signed → anonymous → WAP fallback, so a
  TeraBox-side CAPTCHA wall or payload change no longer takes the whole API
  down. The single-strategy v1 resolver had no recovery path when its one
  approach was blocked.
- **Folder / multi-file support**: shared folders are now expanded
  recursively into every file inside them (bounded by depth, file count, and
  a shared subrequest budget), instead of returning a single unusable
  directory entry.
- **Password-protected shares**: `password` parameter unlocks a share before
  listing it.
- **`GET /hls`**: TeraBox's own adaptive-bitrate manifest, rewritten so every
  segment and encryption key routes back through this worker. This is what
  makes MKV/AVI files playable in a plain `<video>` tag, which byte-range MP4
  proxying alone cannot do.
- **`GET /segment`**: proxies one HLS segment, gated by an HMAC-signed,
  short-lived token minted in `/hls` — never a caller-supplied URL.
- **`POST /api/batch`**: resolve up to 8 links in one call, with bounded
  concurrency and per-link error reporting so one bad link doesn't fail the
  rest.
- **Self-healing streaming**: `/stream` now detects an expired TeraBox
  download link (403/410) and automatically re-resolves and retries once,
  rather than surfacing a confusing failure for what is normally routine
  link expiry.
- **`/share/download` fresh-dlink support**: used both by the self-healing
  path above and directly when a listing returns no usable link.
- **Cookie rotation**: `TERABOX_COOKIE` accepts a comma-separated list of
  accounts, one picked at random per request, to spread load.
- **Richer file metadata**: `md5`, `category`, and the share's `share_id` /
  `uk` identifiers, matching the field set used by comparable commercial
  APIs.
- **Corrected TeraBox errno mapping**: errno `-9` (password required) was
  previously mapped to a generic "not found," producing a misleading dead
  end. The full mapping is now centralized with test coverage per code —
  see `src/lib/errors.ts` and `test/errors.test.ts`.
- **Shared subrequest budget**: every upstream call in a request — including
  retries, mirror fallbacks, and folder recursion — draws from one budget
  capped safely under Cloudflare's free-tier 50-subrequest ceiling, so a
  large folder share degrades to `truncated: true` instead of hard-failing
  with an opaque platform error.
- **`GET /openapi.json`**: a live OpenAPI 3.1 spec whose server URL always
  matches the answering deployment.
- **A docs/playground page at `GET /`**: paste a link, resolve it, see the
  JSON — useful for confirming a fresh deploy works without reaching for
  curl.
- **`scripts/smoke.mjs`**: a live smoke test against a real deployment and a
  real share link, covering resolution, streaming, range requests, HLS, and
  both proxy-safety guards. The mocked test suite cannot substitute for this
  because it exercises logic, not TeraBox's actual current behavior.
- Expanded the TeraBox mirror domain allowlist and added mirror-origin
  sweeping for the API calls themselves (`MIRROR_ORIGINS`).
- `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`,
  `docs/TROUBLESHOOTING.md`.
- 217 Vitest cases (up from a handful) against a purpose-built mocked
  TeraBox (`test/fixtures.ts`) covering every strategy, every fallback
  transition, every errno branch, folder recursion, password flows, the
  subrequest budget ceiling, HLS playlist rewriting, segment-token forgery,
  and end-to-end routing.

### Changed

- **Single cache tier**: replaced the two-tier (KV + promoted memory) cache
  with one — KV when bound, in-memory otherwise — since the previous
  layering added complexity without a corresponding benefit at this TTL.
- **Cache TTL default lowered** from 2 hours to 30 minutes, to sit
  comfortably under typical TeraBox `dlink` lifetime and make expired-link
  errors rare rather than routine.
- **CORS is now unconditionally open** (`Access-Control-Allow-Origin: *`).
  The previous `ALLOWED_ORIGINS` origin-allowlist config was removed: a
  download/streaming API is consumed cross-origin by definition, and origin
  restriction on a self-hosted worker only broke legitimate callers.
  Access control is `API_KEY`'s job, not CORS's.
- **Simplified logging**: replaced the multi-level `Logger` class with a
  single redacting `log()` function — the redaction was the valuable part.
- Removed the `/api/stream` path alias — one canonical path per endpoint.
- Removed the `LOG_REQUESTS` and `MAX_BATCH` environment knobs in favor of
  sensible fixed behavior (errors always log; batch size is fixed at 8,
  set by the subrequest budget rather than being independently tunable).

### Fixed

- `errno -9` no longer maps to "not found" — see Added, above.
- Exception messages and stack traces from truly unexpected errors are no
  longer echoed to the client; they're logged server-side only, redacted,
  with the client receiving a generic `internal` error code.
- When every resolution strategy fails, the caller now sees the most
  actionable error (e.g. a CAPTCHA wall) rather than whichever strategy
  happened to run last.

## [1.0.0] - 2026-09-20

### Added

- Initial public release: `GET`/`POST /` to resolve a TeraBox share link,
  `GET /stream` to proxy the file with byte-range support.
- Host allowlisting on both the share link and the resolved download link.
- Per-isolate in-memory cache for resolved share links (2 hour TTL).
- Full TypeScript rewrite with strict mode, ESLint, Prettier, and a Vitest
  unit test suite for the validation and formatting logic.
- GitHub Actions CI running typecheck, lint, and tests on every push and PR.
