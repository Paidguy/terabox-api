#!/usr/bin/env node
/**
 * Live smoke test — the one thing the mocked suite cannot do.
 *
 * Every unit test in this repo runs against a fake TeraBox, so a green
 * `npm test` proves the logic is correct but not that TeraBox still behaves
 * the way the resolver expects. Run this against a real deployment and a real
 * share link before trusting a release.
 *
 *   node scripts/smoke.mjs <base-url> <share-link> [--key <api-key>] [--password <pw>]
 *
 * Example:
 *   node scripts/smoke.mjs https://terabox-api.you.workers.dev \
 *     "https://terabox.com/s/1AbCdEfGh"
 *
 * Exits non-zero on the first failure, so it works in CI or a cron check.
 */

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1];
};

const positional = args.filter((arg, index) => {
  if (arg.startsWith("--")) return false;
  return !args[index - 1]?.startsWith("--");
});

const [baseUrl, shareLink] = positional;
const apiKey = flag("key");
const password = flag("password");

if (!baseUrl || !shareLink) {
  console.error(
    "Usage: node scripts/smoke.mjs <base-url> <share-link> [--key KEY] [--password PW]",
  );
  process.exit(2);
}

const base = baseUrl.replace(/\/$/, "");
const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

let passed = 0;
let failed = 0;

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    passed++;
    const ms = Date.now() - started;
    console.log(`${GREEN}✓${RESET} ${name} ${DIM}(${ms}ms)${RESET}`);
    if (detail) console.log(`  ${DIM}${detail}${RESET}`);
  } catch (error) {
    failed++;
    console.log(`${RED}✗${RESET} ${name}`);
    console.log(`  ${RED}${error.message}${RESET}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const params = new URLSearchParams({ link: shareLink });
if (password) params.set("password", password);

let resolved = null;

console.log(`\nSmoke testing ${base}\n`);

await check("GET /health", async () => {
  const response = await fetch(`${base}/health`);
  assert(response.ok, `expected 200, got ${response.status}`);

  const body = await response.json();
  assert(body.status === "ok", `unexpected status: ${body.status}`);
  assert(body.config.cookies_configured > 0, "no TERABOX_COOKIE configured on the worker");
  return `version ${body.version}, ${body.config.cookies_configured} cookie(s), kv=${body.config.kv_cache}`;
});

await check("GET /openapi.json", async () => {
  const response = await fetch(`${base}/openapi.json`);
  assert(response.ok, `expected 200, got ${response.status}`);

  const spec = await response.json();
  assert(spec.openapi?.startsWith("3."), "not an OpenAPI 3 document");
  return `${Object.keys(spec.paths).length} paths documented`;
});

await check("GET /api/resolve", async () => {
  const response = await fetch(`${base}/api/resolve?${params}`, { headers });
  const body = await response.json();

  if (!response.ok) {
    throw new Error(`${body.error?.code ?? response.status}: ${body.error?.message ?? "failed"}`);
  }

  assert(Array.isArray(body.files) && body.files.length > 0, "no files returned");
  const file = body.files[0];
  assert(file.file_name, "file has no name");
  assert(file.size_bytes > 0, "file has no size");
  assert(file.stream_url, "no stream_url returned");

  resolved = body;
  return `${body.files.length} file(s) via '${body.share.strategy}' — ${file.file_name} (${file.file_size})`;
});

await check("HEAD stream_url (first byte reachable)", async () => {
  assert(resolved, "resolve step failed, nothing to stream");

  const url = new URL(resolved.files[0].stream_url);
  if (apiKey) url.searchParams.set("key", apiKey);

  const response = await fetch(url, { method: "HEAD", headers });
  assert(response.ok, `expected 200, got ${response.status}`);
  return `content-type ${response.headers.get("content-type")}`;
});

await check("Range request returns 206", async () => {
  assert(resolved, "resolve step failed, nothing to stream");

  const url = new URL(resolved.files[0].stream_url);
  if (apiKey) url.searchParams.set("key", apiKey);

  const response = await fetch(url, { headers: { ...headers, Range: "bytes=0-1023" } });
  assert(response.status === 206, `expected 206, got ${response.status}`);

  const bytes = await response.arrayBuffer();
  assert(bytes.byteLength > 0, "empty body");
  return `${bytes.byteLength} bytes, content-range ${response.headers.get("content-range")}`;
});

const videoFile = resolved?.files.find((file) => file.hls_url);
if (videoFile) {
  await check("GET hls_url returns a playlist", async () => {
    const url = new URL(videoFile.hls_url);
    if (apiKey) url.searchParams.set("key", apiKey);

    const response = await fetch(url, { headers });
    assert(response.ok, `expected 200, got ${response.status}`);

    const playlist = await response.text();
    assert(playlist.startsWith("#EXTM3U"), "not an M3U8 playlist");
    assert(playlist.includes("/segment?t="), "segments were not rewritten through the worker");
    assert(!playlist.includes("terabox.com"), "playlist leaks raw TeraBox URLs");
    return `${playlist.split("\n").filter((line) => line.includes("/segment?t=")).length} segment(s)`;
  });
} else {
  console.log(`${DIM}- skipping HLS: no video file in this share${RESET}`);
}

await check("rejects a non-TeraBox host", async () => {
  const response = await fetch(`${base}/api/resolve?link=https%3A%2F%2Fevil.com%2Fs%2F1a`, {
    headers,
  });
  assert(response.status === 400, `expected 400, got ${response.status}`);

  const body = await response.json();
  assert(body.error.code === "unsupported_host", `unexpected code ${body.error.code}`);
  return "SSRF guard active";
});

await check("rejects a forged segment token", async () => {
  const response = await fetch(`${base}/segment?t=forged.token`, { headers });
  assert(response.status === 403, `expected 403, got ${response.status}`);
  return "open-proxy guard active";
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
