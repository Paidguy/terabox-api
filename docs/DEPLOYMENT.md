# Deployment

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) — the free
  Workers plan is enough for personal use.
- [Node.js](https://nodejs.org/) 20 or later.
- [`wrangler`](https://developers.cloudflare.com/workers/wrangler/) — comes
  in as a dev dependency, so `npm install` gets you `npx wrangler`.

## Getting a TeraBox cookie

The worker authenticates to TeraBox's internal API using a session cookie
from a real (or throwaway) TeraBox account — the same cookie your browser
already carries once you're logged in.

1. Log into [terabox.com](https://www.terabox.com), or one of its mirrors
   (`1024terabox.com` works too), in a normal browser.
2. Open DevTools:
   - Chrome/Edge: **Application** tab → **Storage** → **Cookies** →
     `https://www.terabox.com`
   - Firefox: **Storage** tab → **Cookies**
3. Find the cookie named `ndus` and copy its **value**.

**Use a throwaway account if you can.** This cookie grants whatever it's
attached to full access to that TeraBox account's session — it's
functionally a password. If you'd rather not expose your primary account,
create a free second account just for this.

You can supply the value in any of three forms — the worker normalizes all
of them:

```
ndus=abcdef1234...     # what DevTools shows you, verbatim
abcdef1234...          # bare value, no key= prefix
ndus=A,ndus=B,ndus=C   # several accounts, comma-separated — see below
```

### Multiple accounts (cookie rotation)

Supplying several comma-separated cookies makes the worker pick one at
random per request. This spreads load across accounts, which reduces the
chance that heavy traffic gets any single account rate-limited or flagged by
TeraBox. It's optional — one cookie works fine for personal use.

## Local development

```bash
git clone https://github.com/paidguy/terabox-api.git
cd terabox-api
npm install
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` and paste your cookie value in place of the placeholder.
This file is gitignored and only ever read by `wrangler dev` — it never
reaches a deployment.

```bash
npm run dev
```

This starts a local server (`wrangler dev` prints the URL, typically
`http://localhost:8787`). Try it:

```bash
curl "http://localhost:8787/health"
curl "http://localhost:8787/api/resolve?link=https://terabox.com/s/1EXAMPLE"
```

## Deploying

```bash
wrangler login          # once per machine
wrangler secret put TERABOX_COOKIE
# paste your cookie value when prompted, then Enter
npm run deploy
```

`wrangler deploy` prints your live URL, something like
`https://terabox-api.your-subdomain.workers.dev`. That's it — this is
enough for a fully working deployment.

### Rotating the cookie later

TeraBox session cookies expire after some months. When `/health` still
reports `"status": "ok"` but every resolve starts failing with
`cookie_invalid`, get a fresh cookie (same steps as above) and:

```bash
wrangler secret put TERABOX_COOKIE
```

This overwrites the existing secret; no redeploy needed.

## Optional: API key

Recommended for anything reachable from the public internet, since the
worker carries account-level TeraBox access.

```bash
wrangler secret put API_KEY
# paste a long random string — e.g. `openssl rand -hex 32`
```

Once set, every route except `/`, `/health`, and `/openapi.json` requires
`Authorization: Bearer <key>` or `?key=<key>`. See `docs/API.md#authentication`.

To remove it later: `wrangler secret delete API_KEY`.

## Optional: KV cache

Without this, resolved shares are cached in memory, scoped to whichever
Worker isolate handled the request — fine for personal use, but a busy
worker running on several isolates won't share that cache between them.
Binding a KV namespace makes every isolate see one consistent cache.

```bash
wrangler kv namespace create CACHE
```

This prints something like:

```
[[kv_namespaces]]
binding = "CACHE"
id = "abcd1234ef567890..."
```

Paste that block into `wrangler.toml` (there's a commented placeholder for
it already), then redeploy:

```bash
npm run deploy
```

`GET /health` will report `"kv_cache": true` once it's active.

## Optional: tuning

All have working defaults — only touch these if you have a specific reason
to. Set as plain `[vars]` in `wrangler.toml` (not secrets, since none of
these are sensitive):

| Variable            | Default         | What it controls                                                                                                              |
| ------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `CACHE_TTL`         | `1800` (30 min) | How long a resolved share is cached, in seconds. Kept under typical `dlink` lifetime on purpose — see `docs/ARCHITECTURE.md`. |
| `RATE_LIMIT`        | `30`            | Requests per IP per window on metered endpoints. `0` disables limiting entirely.                                              |
| `RATE_LIMIT_WINDOW` | `60`            | The window length, in seconds.                                                                                                |

```toml
[vars]
CACHE_TTL = "3600"
RATE_LIMIT = "60"
RATE_LIMIT_WINDOW = "60"
```

## Custom domain

In the Cloudflare dashboard: **Workers & Pages** → your worker → **Settings**
→ **Domains & Routes** → **Add** → **Custom Domain**. Follow the prompts to
point a domain or subdomain you control at the worker. `GET /openapi.json`
will automatically reflect the new domain in `servers[0].url` — nothing to
change in code.

## Verifying a deployment

Once deployed with a real cookie:

```bash
node scripts/smoke.mjs https://your-worker.workers.dev "https://terabox.com/s/1EXAMPLE"
```

Add `--key <your-api-key>` if you set one, `--password <pw>` if the test
share needs it. This is the check that exercises real TeraBox — see the main
[`README.md`](../README.md#checking-a-deployment). Something failing here is covered in
[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

## Monitoring

```bash
npm run tail
```

Streams live structured JSON logs from the deployed worker
(`wrangler tail` under the hood). Every log line is redacted before it's
written — cookies, tokens, signatures, and download links never appear, even
in an error dump. See `src/lib/log.ts` if you want to verify that yourself.
