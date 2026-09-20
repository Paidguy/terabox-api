import type { Env, TeraboxShare } from "../types";

/**
 * Default TTL, deliberately well under the lifetime of a TeraBox dlink.
 *
 * Serving a cached share whose signed download URLs have already expired
 * produces a confusing 403 at stream time, so the cache is tuned to expire
 * first. `/stream` additionally re-resolves on a 403, which covers the rest.
 */
const DEFAULT_TTL_SECONDS = 30 * 60;
/** Cap the in-memory map so a burst of unique links can't grow it forever. */
const MAX_MEMORY_ENTRIES = 300;

interface Entry {
  share: TeraboxShare;
  expiresAt: number;
}

/** Insertion-ordered Map doubles as a cheap LRU. */
const memory = new Map<string, Entry>();

export function cacheTtlSeconds(env: Env): number {
  const parsed = parseInt(env.CACHE_TTL ?? "", 10);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_TTL_SECONDS;
  // KV enforces a 60s floor on expirationTtl.
  return Math.max(60, parsed);
}

/**
 * Read a cached share.
 *
 * When a KV namespace is bound it is the single source of truth, so every
 * isolate sees the same entry; without one the cache is per-isolate memory.
 * Cache failures are never fatal — a miss just means a live resolve.
 */
export async function getCachedShare(env: Env, key: string): Promise<TeraboxShare | null> {
  if (env.CACHE) {
    try {
      const stored = await env.CACHE.get(key, "json");
      return stored ? (stored as TeraboxShare) : null;
    } catch {
      return null;
    }
  }

  const hit = memory.get(key);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    memory.delete(key);
    return null;
  }
  // Refresh recency: delete + re-set moves the key to the end of the Map.
  memory.delete(key);
  memory.set(key, hit);
  return hit.share;
}

export async function putCachedShare(env: Env, key: string, share: TeraboxShare): Promise<void> {
  const ttl = cacheTtlSeconds(env);

  if (env.CACHE) {
    try {
      await env.CACHE.put(key, JSON.stringify(share), { expirationTtl: ttl });
    } catch {
      // A cache write failing is not a request failure.
    }
    return;
  }

  if (memory.size >= MAX_MEMORY_ENTRIES) {
    const oldest = memory.keys().next();
    if (!oldest.done) memory.delete(oldest.value);
  }
  memory.set(key, { share, expiresAt: Date.now() + ttl * 1000 });
}

/** Drop an entry whose download links turned out to be dead. */
export async function dropCachedShare(env: Env, key: string): Promise<void> {
  memory.delete(key);
  if (!env.CACHE) return;
  try {
    await env.CACHE.delete(key);
  } catch {
    // Best effort.
  }
}

/** Test-only: reset in-memory state between cases. */
export function _clearMemoryCache(): void {
  memory.clear();
}
