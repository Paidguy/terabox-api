/** Video qualities TeraBox exposes through its streaming endpoint. */
export const HLS_QUALITIES = ["M3U8_AUTO_480", "M3U8_AUTO_720", "M3U8_AUTO_1080"] as const;
export type HlsQuality = (typeof HLS_QUALITIES)[number];

const QUALITY_ALIASES: Record<string, HlsQuality> = {
  "480": "M3U8_AUTO_480",
  "480p": "M3U8_AUTO_480",
  sd: "M3U8_AUTO_480",
  "720": "M3U8_AUTO_720",
  "720p": "M3U8_AUTO_720",
  hd: "M3U8_AUTO_720",
  "1080": "M3U8_AUTO_1080",
  "1080p": "M3U8_AUTO_1080",
  fhd: "M3U8_AUTO_1080",
};

/** Normalise a caller-supplied quality, defaulting to 720p. */
export function normalizeQuality(raw: string | null | undefined): HlsQuality {
  if (!raw) return "M3U8_AUTO_720";
  const trimmed = raw.trim();
  if ((HLS_QUALITIES as readonly string[]).includes(trimmed)) return trimmed as HlsQuality;
  return QUALITY_ALIASES[trimmed.toLowerCase()] ?? "M3U8_AUTO_720";
}

/** A response is a playlist if it starts with the HLS magic line. */
export function looksLikePlaylist(body: string): boolean {
  return body.trimStart().startsWith("#EXTM3U");
}

/**
 * Rewrite every URL in an M3U8 playlist to point back at this worker.
 *
 * Segments and encryption keys need the TeraBox cookie and referer to load,
 * which a browser can't supply cross-origin — so each one is replaced with a
 * `/segment` URL carrying a signed token. Relative URLs are resolved against
 * the manifest's own location first, since TeraBox emits both forms.
 *
 * `mintToken` is async, so URLs are collected, signed in parallel, then
 * substituted — one pass, no sequential round trips.
 */
export async function rewritePlaylist(
  playlist: string,
  manifestUrl: string,
  origin: string,
  mintToken: (url: string) => Promise<string>,
): Promise<string> {
  const lines = playlist.split(/\r?\n/);
  const targets = new Set<string>();

  const absolute = (raw: string): string | null => {
    try {
      return new URL(raw, manifestUrl).toString();
    } catch {
      return null;
    }
  };

  // Pass 1 — collect every URL the player will need.
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    if (!trimmed.startsWith("#")) {
      const resolved = absolute(trimmed);
      if (resolved) targets.add(resolved);
      continue;
    }

    // #EXT-X-KEY and #EXT-X-MAP carry their URL in a URI="..." attribute.
    const uriMatch = /URI="([^"]+)"/.exec(trimmed);
    const uri = uriMatch?.[1];
    if (uri) {
      const resolved = absolute(uri);
      if (resolved) targets.add(resolved);
    }
  }

  const proxied = new Map<string, string>();
  await Promise.all(
    [...targets].map(async (url) => {
      proxied.set(url, `${origin}/segment?t=${encodeURIComponent(await mintToken(url))}`);
    }),
  );

  // Pass 2 — substitute.
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === "") return line;

      if (!trimmed.startsWith("#")) {
        const resolved = absolute(trimmed);
        return (resolved && proxied.get(resolved)) ?? line;
      }

      return line.replace(/URI="([^"]+)"/, (whole, uri: string) => {
        const resolved = absolute(uri);
        const replacement = resolved ? proxied.get(resolved) : undefined;
        return replacement ? `URI="${replacement}"` : whole;
      });
    })
    .join("\n");
}
