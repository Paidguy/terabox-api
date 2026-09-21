# TeraBox API

A self-hosted [Cloudflare Worker](https://workers.cloudflare.com/) that turns
a public TeraBox share link into file metadata, a direct download, and a
browser-playable stream — including MKV and AVI, via HLS.

[![CI](https://github.com/paidguy/terabox-api/actions/workflows/ci.yml/badge.svg)](https://github.com/paidguy/terabox-api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

## Why this one

Most TeraBox resolvers do one thing: scrape a page token, call one API, hope
it works. TeraBox rotates its defenses often enough that "hope it works" fails
in practice. This one tries three different resolution strategies in order —
the same signed API the official player uses, an anonymous fallback that
survives when the signed one is CAPTCHA-walled, and a mobile-page scrape as a
last resort — and it recovers automatically when a cached download link
expires mid-stream.

## Features

- **Multi-strategy resolution** — signed → anonymous → WAP fallback, so a
  TeraBox-side change to one path doesn't take the whole API down. See
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
- **Folders, not just files** — shared folders are expanded recursively into
  every file inside them, up to a bounded depth and file count.
- **Password-protected shares** — supply `password` and the worker unlocks
  the share before listing it.
- **Direct download & streaming** — `GET /stream` proxies the file with full
  `Range` support: seeking, resumable downloads, `<video>` tags.
- **HLS for anything a browser can't play natively** — `GET /hls` returns
  TeraBox's own adaptive manifest, rewritten so every segment routes back
  through this worker. This is what makes MKV and AVI files playable in a
  plain `<video>` tag via [hls.js](https://github.com/video-dev/hls.js).
- **Self-healing cache** — a resolved share is cached briefly, and if the
  download link inside it has expired by the time you stream, the worker
  re-resolves automatically rather than handing you a 403.
- **Batch resolve** — `POST /api/batch` resolves several links in one call,
  with bounded concurrency and per-link error reporting.
- **Security by construction** — every proxy endpoint (`/stream`, `/segment`)
  re-derives what it fetches from a value _this worker_ signed; a caller can
  never point it at an arbitrary URL. See [`SECURITY.md`](SECURITY.md).
- **Typed and linted** — strict TypeScript, ESLint, and Prettier.
- **Zero external services required** — runs entirely on Cloudflare's free
  tier. Workers KV is optional, for a cache that survives isolate recycling.

## Quickstart

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- [Node.js](https://nodejs.org/) 20+
- A TeraBox account, logged in via browser (to get a session cookie) —
  see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md#getting-a-terabox-cookie)

### 1. Clone and install

```bash
git clone https://github.com/paidguy/terabox-api.git
cd terabox-api
npm install
```

### 2. Configure your cookie

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars and paste your ndus cookie
```

### 3. Run locally

```bash
npm run dev
```

### 4. Deploy

```bash
wrangler login
wrangler secret put TERABOX_COOKIE
npm run deploy
```

Full walkthrough, including the API key and KV cache setup, is in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## API

Full reference with every parameter and error code:
[`docs/API.md`](docs/API.md). A machine-readable spec is served live at
`GET /openapi.json` on any deployment.

### Resolve a share link

```bash
curl "https://your-worker.workers.dev/api/resolve?link=https://terabox.com/s/1EXAMPLE"
```

```json
{
  "status": "success",
  "cached": false,
  "url": "https://terabox.com/s/1EXAMPLE",
  "share": {
    "id": "1EXAMPLE",
    "share_id": "918273645",
    "uk": "445566778",
    "password_protected": false,
    "file_count": 1,
    "truncated": false,
    "strategy": "signed"
  },
  "files": [
    {
      "fs_id": "901464181182712",
      "file_name": "example.mp4",
      "file_size": "500.00 MB",
      "size_bytes": 524288000,
      "category": "video",
      "mime_type": "video/mp4",
      "md5": "d41d8cd98f00b204e9800998ecf8427e",
      "thumbnail": "https://.../thumb.jpg",
      "stream_url": "https://your-worker.workers.dev/stream?link=...&fs_id=...",
      "download_url": "https://your-worker.workers.dev/stream?link=...&download=1",
      "hls_url": "https://your-worker.workers.dev/hls?link=...&fs_id=..."
    }
  ]
}
```

On failure you get a matching HTTP status and
`{ "status": "error", "error": { "code": "...", "message": "..." } }` —
`code` is the stable contract; branch on that, not on `message`. Full list in
[`docs/API.md#error-codes`](docs/API.md#error-codes).

### Play it in a browser

```html
<!-- MP4, and anything else a browser decodes natively -->
<video controls src="https://your-worker.workers.dev/stream?link=ENCODED_LINK"></video>

<!-- MKV, AVI, or anything else — via HLS -->
<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
<video id="v" controls></video>
<script>
  const hls = new Hls();
  hls.loadSource("https://your-worker.workers.dev/hls?link=ENCODED_LINK&quality=720");
  hls.attachMedia(document.getElementById("v"));
</script>
```

### More examples

Working code in [`examples/`](examples/): [curl](examples/curl.sh),
[Node fetch](examples/node-fetch.mjs), [Python](examples/python-requests.py),
and a [standalone HTML player](examples/player.html).

## Project structure

```
src/
  index.ts             Router, auth, rate limiting, error envelope
  handlers.ts          Request handlers for every route
  openapi.ts           OpenAPI 3.1 spec, served at /openapi.json
  types.ts             Env bindings and shared result types
  ui/landing.ts        The docs/playground page at GET /
  lib/
    terabox.ts          The resolver: three strategies, folder walk, mirrors
    terabox-parse.ts     Pure parsing — tokens, __INITIAL_STATE__, file records
    hls.ts              M3U8 playlist rewriting
    sign.ts             HMAC tokens that keep /segment from being an open proxy
    validate.ts         Host allowlists, link parsing (the security-critical bit)
    cookies.ts          Cookie pool parsing and rotation
    cache.ts            Share cache — KV when bound, memory otherwise
    ratelimit.ts        Per-IP rate limiting
    budget.ts           Shared subrequest budget + retrying fetch
    format.ts           Byte sizes, MIME/category guessing, Content-Disposition
    errors.ts           Typed errors and the TeraBox errno map
    http.ts             CORS, JSON envelope, error rendering
    log.ts              Structured logging with secret redaction
scripts/
  smoke.mjs            Live smoke check against a real deployment (see below)
docs/
  API.md               Full endpoint and error reference
  ARCHITECTURE.md       How resolution actually works, and why three strategies
  DEPLOYMENT.md         Cookie setup, secrets, KV, custom domains
  TROUBLESHOOTING.md    Symptom → cause → fix
```

## Checking a deployment

TeraBox's behavior can change at any time, so the only real proof that a
deployment works is a real link. **Before trusting one, run:**

```bash
node scripts/smoke.mjs https://your-worker.workers.dev "https://terabox.com/s/1EXAMPLE"
```

This hits your live worker with a real share link and checks resolution, byte
streaming, range requests, HLS (if the file is a video), and both security
guards. See [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) if anything
fails.

## Limits

- **This is an unofficial integration with no API contract.** TeraBox can
  change its internals at any time. The three-strategy design exists
  specifically as insurance against that — see
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — but it's insurance, not
  immunity.
- **Cookie expiry.** TeraBox session cookies expire after some months. When
  every strategy starts failing with `cookie_invalid`, log in again and
  rotate the `TERABOX_COOKIE` secret.
- **Download links expire.** TeraBox's signed `dlink` URLs are short-lived.
  `/stream` re-resolves automatically on a 403/410; a `stream_url` you saved
  from an old `/api/resolve` response may still need that recovery to kick in
  on first use.
- **Cache durability.** Without a bound KV namespace, the cache lives only as
  long as one Worker isolate does. See
  [`docs/DEPLOYMENT.md#optional-kv-cache`](docs/DEPLOYMENT.md#optional-kv-cache).
- **Free-tier subrequest budget.** Every request — including folder
  recursion and retries — is capped at 40 upstream calls, safely under
  Cloudflare's 50-per-request free-tier ceiling. A very large or deep folder
  share will come back `truncated: true` rather than exceeding it.

## Responsible use

This tool only works with links that are already publicly shared, and only
extracts what TeraBox's own share page already exposes to anyone holding the
link — it doesn't bypass access controls on private files. That said, using
it may be against TeraBox's terms of service, and you're responsible for
complying with those terms and any laws that apply to the content you access
in your jurisdiction. Licensed as-is with no warranty — see
[`LICENSE`](LICENSE).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

[MIT](LICENSE)
