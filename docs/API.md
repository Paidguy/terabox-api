# API Reference

Base URL is wherever you deployed the worker, e.g.
`https://terabox-api.you.workers.dev`. A live, always-current machine-readable
version of everything below is served at `GET /openapi.json`.

## Authentication

Open by default. If you set the `API_KEY` secret, every route below except
`GET /`, `GET /health`, and `GET /openapi.json` requires one of:

```
Authorization: Bearer <key>
```

or, for contexts that can't set headers (a `<video>` tag, a download
manager):

```
?key=<key>
```

A missing or wrong key returns `401` with `error.code: "unauthorized"`.

## Response envelope

Every JSON endpoint responds with either:

```json
{ "status": "success", ... }
```

or

```json
{
  "status": "error",
  "error": { "code": "...", "message": "...", "...": "extra fields vary by code" },
  "request_id": "..."
}
```

**`error.code` is the stable contract.** `error.message` is for humans and
its wording may change between versions — never match against it in code.
`request_id` is also echoed as the `X-Request-Id` response header on every
request, success or failure, and is what you'd include in a bug report.

---

## `GET /api/resolve`

Resolve a share link to its file(s).

| Parameter             | Required               | Description                                                |
| --------------------- | ---------------------- | ---------------------------------------------------------- |
| `link` (or `url`)     | yes                    | A public TeraBox share URL.                                |
| `password` (or `pwd`) | if the share needs one | Unlocks a password-protected share.                        |
| `fs_id`               | no                     | Narrow the response to one file inside a multi-file share. |

```bash
curl "https://your-worker.workers.dev/api/resolve?link=https://terabox.com/s/1EXAMPLE"
```

### `POST /api/resolve`

Same thing, body instead of query string. Accepts JSON:

```bash
curl -X POST https://your-worker.workers.dev/api/resolve \
  -H "Content-Type: application/json" \
  -d '{"link": "https://terabox.com/s/1EXAMPLE", "password": "1234"}'
```

or `application/x-www-form-urlencoded` with the same field names.

### Response shape

```jsonc
{
  "status": "success",
  "cached": false, // true if served from cache without hitting TeraBox
  "url": "https://terabox.com/s/1EXAMPLE",
  "share": {
    "id": "1EXAMPLE", // short share id (surl)
    "share_id": "918273645", // TeraBox's numeric share id
    "uk": "445566778", // owner user key
    "resolved_url": "https://www.terabox.com/sharing/link?surl=EXAMPLE",
    "password_protected": false,
    "file_count": 1,
    "truncated": false, // true if the 200-file cap left entries out
    "strategy": "signed", // "signed" | "anonymous" | "wap" — see ARCHITECTURE.md
  },
  "files": [
    {
      "fs_id": "901464181182712",
      "file_name": "example.mp4",
      "path": "/example.mp4",
      "file_size": "500.00 MB",
      "size_bytes": 524288000,
      "category": "video", // video | audio | image | document | application | other
      "mime_type": "video/mp4",
      "md5": "d41d8cd98f00b204e9800998ecf8427e",
      "thumbnail": "https://.../thumb.jpg",
      "modified_at": 1730000000, // unix seconds, or null
      "stream_url": "https://your-worker.workers.dev/stream?link=...&fs_id=...",
      "download_url": "https://your-worker.workers.dev/stream?link=...&download=1",
      "hls_url": "https://your-worker.workers.dev/hls?link=...&fs_id=...", // null for non-video
    },
  ],
  // Flat aliases for files[0], kept for v1 compatibility:
  "file_name": "example.mp4",
  "file_size": "500.00 MB",
  "size_bytes": 524288000,
  "thumbnail": "https://.../thumb.jpg",
  "stream_url": "https://your-worker.workers.dev/stream?link=...&fs_id=...",
}
```

---

## `POST /api/batch`

Resolve up to 8 links in one call.

```bash
curl -X POST https://your-worker.workers.dev/api/batch \
  -H "Content-Type: application/json" \
  -d '{"links": ["https://terabox.com/s/1A", "https://terabox.com/s/1B"]}'
```

```json
{
  "status": "success",
  "total": 2,
  "succeeded": 1,
  "failed": 1,
  "results": [
    { "status": "success", "url": "https://terabox.com/s/1A", "share": {...}, "files": [...] },
    { "status": "error", "url": "https://terabox.com/s/1B", "error": { "code": "not_found", "message": "..." } }
  ]
}
```

One bad link never fails the whole batch — the HTTP status is `200` as long
as the request itself was valid, and each entry in `results` reports its own
`status`. `password` in the request body applies to every link in the batch;
mixed passwords aren't supported in one call.

Batch size is capped at 8, not arbitrarily — it's set by the shared
subrequest budget (see `docs/ARCHITECTURE.md#the-subrequest-budget`), so
raising it isn't just a config change.

---

## `GET` / `HEAD /stream`

Proxy the file bytes.

| Parameter  | Required  | Description                                                           |
| ---------- | --------- | --------------------------------------------------------------------- |
| `link`     | yes       | The share link (not a download URL — see `SECURITY.md`).              |
| `fs_id`    | no        | Which file, for a multi-file share. Defaults to the first.            |
| `password` | if needed | Share password.                                                       |
| `download` | no        | `1` forces `Content-Disposition: attachment` even for playable media. |

Supports the standard `Range` request header — this is what makes seeking in
a `<video>` tag and resumable downloads in a download manager work. A `Range`
request gets back `206 Partial Content`; a plain request gets `200`.

```html
<video controls src="https://your-worker.workers.dev/stream?link=ENCODED_LINK"></video>
```

```bash
# Resume a partial download
curl -H "Range: bytes=1000000-" -O https://your-worker.workers.dev/stream?link=ENCODED_LINK
```

`HEAD` returns the same headers with no body — useful for checking size and
content type before committing to a download.

If the underlying TeraBox download link has expired, this endpoint
re-resolves the share and retries automatically before giving up — see
`docs/ARCHITECTURE.md#dlink-expiry-and-self-healing`.

---

## `GET /hls`

TeraBox's own adaptive-bitrate manifest for a video file, rewritten so every
segment and encryption key routes back through this worker instead of
requiring the client to hold a TeraBox cookie.

| Parameter  | Required  | Description                                             |
| ---------- | --------- | ------------------------------------------------------- |
| `link`     | yes       | The share link.                                         |
| `fs_id`    | no        | Which file. Must resolve to a `category: "video"` file. |
| `password` | if needed | Share password.                                         |
| `quality`  | no        | `480`, `720` (default), or `1080`.                      |

```html
<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
<video id="v" controls></video>
<script>
  const hls = new Hls();
  hls.loadSource("https://your-worker.workers.dev/hls?link=ENCODED_LINK&quality=720");
  hls.attachMedia(document.getElementById("v"));
</script>
```

Returns `Content-Type: application/vnd.apple.mpegurl`. Safari and native
`<video>` elements on iOS can play this URL directly without hls.js; every
other browser needs an HLS-capable player.

Returns `400 invalid_parameter` if `fs_id` doesn't point at a video, and
`502 upstream_unexpected` if TeraBox doesn't have a manifest ready for this
file (some shares don't expose one — use `stream_url` instead).

---

## `GET /segment`

Proxies one HLS segment or encryption key. **Not meant to be called
directly** — the URLs inside a rewritten `/hls` playlist already point here
with a signed token attached. A request with any other token value returns
`403`. See `SECURITY.md` for why this exists.

---

## `GET /health`

Liveness and configuration summary. Always public, even with `API_KEY` set.

```json
{
  "status": "ok",
  "version": "2.0.2",
  "timestamp": "2026-09-20T12:00:00.000Z",
  "config": {
    "cookies_configured": 1,
    "auth_required": false,
    "kv_cache": false,
    "rate_limit": "30",
    "rate_limit_window": "60"
  }
}
```

No secrets are ever included — `cookies_configured` is a count, not the
values.

---

## `GET /openapi.json`

The OpenAPI 3.1 document for this exact deployment — `servers[0].url` always
matches the origin that answered the request, so "Try it out" in Swagger UI
or Postman works without editing anything.

---

## v1 compatibility

Kept working, indefinitely:

- `GET /?link=<url>` and `POST /` with `{"link": "..."}` behave exactly like
  `/api/resolve`.
- The flat `file_name` / `file_size` / `stream_url` fields on every resolve
  response mirror `files[0]`.

A bare `GET /` with no `link` parameter serves the HTML docs/playground page
instead.

---

## Error codes

| Code                    | HTTP status | Meaning                                                         | What to do                                                                                                           |
| ----------------------- | ----------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `missing_parameter`     | 400         | A required parameter wasn't sent.                               | Check the request.                                                                                                   |
| `invalid_parameter`     | 400         | A parameter was present but unusable.                           | Check the value against the limits in this doc.                                                                      |
| `unsupported_host`      | 400         | The link's host isn't a recognised TeraBox domain.              | Check the URL; see the domain list in `docs/ARCHITECTURE.md`.                                                        |
| `unauthorized`          | 401         | Missing or wrong API key.                                       | Send `Authorization: Bearer <key>`.                                                                                  |
| `password_required`     | 401         | The share needs a password (or the one given was wrong).        | Retry with `password`.                                                                                               |
| `empty_share`           | 404         | The share has no downloadable files.                            | Nothing to do — the share is empty from every angle tried.                                                           |
| `not_found`             | 404         | The share, or the requested `fs_id`, doesn't exist.             | Check the link and any `fs_id`.                                                                                      |
| `rate_limited`          | 429         | Too many requests from this client.                             | Back off; see the `Retry-After` header.                                                                              |
| `verification_required` | 503         | TeraBox is demanding a CAPTCHA on this request.                 | **Retryable.** Usually clears within minutes; a different IP sometimes helps.                                        |
| `cookie_invalid`        | 502         | TeraBox rejected the session token.                             | The `TERABOX_COOKIE` secret has likely expired — see `DEPLOYMENT.md`.                                                |
| `budget_exhausted`      | 503         | The per-request upstream call budget ran out.                   | Usually a very large folder — request a single file with `fs_id` instead of the whole share.                         |
| `upstream_unexpected`   | 502         | TeraBox answered, but not in a shape this worker could parse.   | Often transient; if persistent, TeraBox likely changed something — file an issue.                                    |
| `upstream_unavailable`  | 502         | TeraBox was unreachable, timed out, or returned a server error. | Retryable.                                                                                                           |
| `internal`              | 500         | Something unanticipated.                                        | The response never includes the underlying detail (see `SECURITY.md`); check `wrangler tail` on your own deployment. |

`verification_required` and `budget_exhausted` are worth calling out
specifically: unlike most `5xx`s, they're expected, transient conditions that
this API surfaces on purpose rather than errors in the worker itself.
