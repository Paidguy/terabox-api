#!/usr/bin/env node
/**
 * Example: using the TeraBox API from Node with the built-in fetch.
 * No dependencies — works on Node 18+.
 *
 *   node examples/node-fetch.mjs <share-link> [base-url] [api-key]
 */

const [, , link, baseUrl = "https://your-worker.workers.dev", apiKey] = process.argv;

if (!link) {
  console.error("Usage: node node-fetch.mjs <share-link> [base-url] [api-key]");
  process.exit(1);
}

const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

async function resolve(shareLink) {
  const url = new URL("/api/resolve", baseUrl);
  url.searchParams.set("link", shareLink);

  const response = await fetch(url, { headers });
  const body = await response.json();

  if (!response.ok) {
    throw new Error(`${body.error.code}: ${body.error.message}`);
  }
  return body;
}

async function downloadTo(streamUrl, destPath) {
  const { createWriteStream } = await import("node:fs");
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");

  const url = new URL(streamUrl);
  if (apiKey) url.searchParams.set("key", apiKey);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);

  await pipeline(Readable.fromWeb(response.body), createWriteStream(destPath));
}

const share = await resolve(link);

console.log(`Resolved via '${share.share.strategy}' strategy:`);
for (const file of share.files) {
  console.log(`  - ${file.file_name} (${file.file_size}, ${file.category})`);
}

const first = share.files[0];
console.log(`\nDownloading '${first.file_name}'...`);
await downloadTo(first.stream_url, first.file_name);
console.log(`Saved to ./${first.file_name}`);

if (first.hls_url) {
  console.log(`\nThis file also has an HLS manifest for browser playback:`);
  console.log(`  ${first.hls_url}`);
}
