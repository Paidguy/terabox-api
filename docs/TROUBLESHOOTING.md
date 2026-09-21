# Troubleshooting

Find your symptom below. Most of these map directly to an `error.code` in the
JSON response — see [`API.md#error-codes`](API.md#error-codes) for the full
table.

---

### Every request fails with `cookie_invalid`

**Cause:** The `TERABOX_COOKIE` secret is missing, empty, or the session it
represents has expired. TeraBox cookies expire after some months of
inactivity or on TeraBox's own schedule.

**Fix:**

1. Confirm it's set at all: `GET /health` → `config.cookies_configured`
   should be `1` or more. If it's `0`, the secret was never set — see
   [`DEPLOYMENT.md`](DEPLOYMENT.md#deploying).
2. If it is set but requests still fail, get a fresh cookie
   ([steps here](DEPLOYMENT.md#getting-a-terabox-cookie)) and rotate it:
   ```bash
   wrangler secret put TERABOX_COOKIE
   ```

---

### `/stream` returns `upstream_unexpected` — "did not expose the signature"

**Cause:** the share listed, but neither the share page nor `/share/list` carried
its `shareid` / `uk` / `sign` / `timestamp`, and the fallback lookups
(`/share/tplconfig`, `/api/shorturlinfo`, then the mobile page) found none
either. It is **not** a cookie problem.

**Fix:** deploy 2.0.2 or later (`GET /health` shows the version). 2.0.2 added
`/share/tplconfig` as the first fallback, which needs no page token and
resolves most shares that 2.0.1 still failed on. If it still happens,
`npm run tail` and look for `share exposed no signature` — it means TeraBox
refused every lookup for that share from your Worker's IP, which is usually
temporary (TeraBox is known to withhold signed links from datacenter IPs on
some shares regardless of cookie validity; it tends to clear on its own, and
a fresher `TERABOX_COOKIE` from a real logged-in browser session sometimes
helps where retrying alone doesn't).

---

### Requests fail with `verification_required`

**Cause:** TeraBox is asking for a CAPTCHA on this specific request pattern.
This is a known, expected condition (see
[`ARCHITECTURE.md`](ARCHITECTURE.md#errno-handling)) — the resolver already
tried its anonymous and WAP fallbacks and all of them hit the same wall.

**Fix:** This is retryable by design (`503`, with the code telling you so
explicitly). Wait a few minutes and try again. If it persists for hours
across many different share links, TeraBox may be walling requests from your
Worker's outbound IP range more broadly — there's no fix inside this project
for that; it usually clears on its own.

---

### One specific share always fails, others work fine

**Cause:** almost always one of:

- **`password_required`** — the share is password-protected. Retry with
  `?password=...`.
- **`not_found`** — the link is malformed, the share was deleted, or it was
  never public. Open it in a real browser first to confirm it's still valid.
- **`empty_share`** — the share exists but every strategy found zero files
  (e.g. a folder containing only empty subfolders past the depth limit).

Check `error.code` in the response — it will say which of these it is.

---

### A folder share comes back with `"truncated": true`

**Not an error.** It means either the 200-file cap or the subrequest budget
was hit while walking a very large or very deep folder. You'll still get
whatever files were found before the limit — check `share.file_count`.

**If you need a specific file that's missing:** if you know its `fs_id`, you
generally don't need the full listing — request that file with
`?fs_id=...`, which skips the exhaustive folder walk entirely once the
specific file is found.

---

### `/stream` returns `502` after working fine moments ago

**Cause:** the TeraBox `dlink` behind a cached `stream_url` expired between
when you resolved the share and when you tried to play it. The worker
already retries this automatically once (see
[`ARCHITECTURE.md#dlink-expiry-and-self-healing`](ARCHITECTURE.md#dlink-expiry-and-self-healing))
— a `502` here means even the retry failed.

**Fix:** call `/api/resolve` again to get a fresh `stream_url` rather than
reusing an old one indefinitely. If it fails immediately on a freshly
resolved link too, check whether the underlying issue is actually
`cookie_invalid` or `verification_required` instead (read `error.code`, not
just the status).

---

### `/hls` returns `400 invalid_parameter`

**Cause:** the selected file (default: the first one, or whichever `fs_id`
you passed) isn't a video. HLS is only meaningful for video files; use
`stream_url` for anything else.

**Fix:** check `files[].category` in the resolve response and pick a file
where `category === "video"` — or just use its own `hls_url`, which is
`null` on non-video entries specifically so you don't have to guess.

---

### `/hls` returns `502` with "TeraBox did not return a playable manifest"

**Cause:** not every TeraBox share exposes a streaming manifest for a given
file — some are only available as a direct download. This is a TeraBox-side
limitation, not a bug in the resolver.

**Fix:** fall back to `stream_url` for that file. If the video plays fine as
an MP4 via `/stream` but never gets an HLS manifest, that's expected —
`/stream` remains the primary path; `/hls` is specifically for containers a
browser can't decode natively (MKV, AVI).

---

### `429 rate_limited`

**Cause:** more requests from one IP than `RATE_LIMIT` allows within
`RATE_LIMIT_WINDOW` seconds (defaults: 30 per 60s).

**Fix:** back off for the number of seconds in the `Retry-After` header. If
this is your own traffic and the default is too strict, raise `RATE_LIMIT`
in `wrangler.toml` — see [`DEPLOYMENT.md#optional-tuning`](DEPLOYMENT.md#optional-tuning).
Setting `RATE_LIMIT=0` disables limiting entirely (not recommended for a
publicly reachable deployment, since the account behind `TERABOX_COOKIE` pays
the price of unlimited traffic).

---

### `401 unauthorized` on every request

**Cause:** `API_KEY` is set on the deployment and the request didn't send a
matching key.

**Fix:** send `Authorization: Bearer <key>` or `?key=<key>`. If you don't
remember setting `API_KEY`, check with `wrangler secret list` — someone
(possibly a past you) turned auth on. Remove it with
`wrangler secret delete API_KEY` if you want the deployment open again.

---

### `budget_exhausted`

**Cause:** the per-request cap on upstream calls (40, to stay under
Cloudflare's free-tier limit of 50) was used up — almost always on an
unusually large or deeply nested folder share.

**Fix:** request a single file by `fs_id` instead of resolving the whole
folder. See [`ARCHITECTURE.md#the-subrequest-budget`](ARCHITECTURE.md#the-subrequest-budget)
for why this cap exists and isn't simply raised.

---

### The worker deploys fine but `npm run smoke` fails on everything

**Cause:** usually one of:

- No cookie configured on the _deployed_ worker (local `.dev.vars` doesn't
  carry over — you need `wrangler secret put TERABOX_COOKIE` separately for
  production).
- The share link used for the smoke test is itself invalid, private, or
  deleted — try it in a browser first.
- `API_KEY` is set on the deployment but wasn't passed to the smoke script
  (`--key <key>`).

Run `curl https://your-worker.workers.dev/health` by hand first — if that
fails too, the issue is deployment-level, not resolver-level.

---

### Something isn't covered here

1. Check `error.code` in the JSON response against the full table in
   [`API.md#error-codes`](API.md#error-codes) — it's more specific than any
   generic HTTP status.
2. Run `wrangler tail` (`npm run tail`) against your live deployment and
   reproduce the request — every log line includes the failure reason with
   secrets redacted.
3. If it looks like TeraBox changed something structurally (a payload shape,
   an endpoint), that's a real possibility — see the "no API contract"
   caveat in the main [`README.md`](../README.md#limits) — and worth filing
   as an issue with the `error.code`, the share link's domain (not the full
   link), and the `wrangler tail` output.
