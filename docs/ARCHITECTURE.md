# Architecture

## Why three resolution strategies

TeraBox's public share pages are backed by an internal API that isn't
documented and changes without notice. At various points it has required a
signed request (a `jsToken` scraped from the share page, paired with a
sign/timestamp pair from the share record); at other points that signed path
has been walled behind a CAPTCHA gate (`errno 400210`, `"need verify_v2"`)
while a plain unsigned call to the same endpoint kept working; and TeraBox's
own mobile web app gets its file list from an entirely different source — a
JSON blob (`window.__INITIAL_STATE__`) embedded directly in the page HTML.

A resolver that only implements one of these breaks completely the moment
that one path is walled or restructured. This one tries all three, in order,
and only fails once every strategy has failed:

```
1. signed      — jsToken + sign/timestamp → /share/list
                 (what the official web player does; richest metadata)
2. anonymous   — /share/list with no jsToken or signature
                 (works surprisingly often when the signed call is walled)
3. wap         — scrape window.__INITIAL_STATE__ from the mobile share page
                 (least standard payload shape; used only as a last resort)
```

Each strategy fails in a genuinely different way — a stale token, a CAPTCHA
wall, a restructured payload — which is precisely why trying all three
recovers from more failure modes than retrying one strategy harder would.

### Where each strategy gets its identifiers

- **The share page** (`openShare` in `src/lib/terabox.ts`) is fetched first,
  regardless of strategy. It resolves the short link to its final URL,
  extracts the share id, and — when the page cooperates — a `jsToken` and the
  `sign`/`timestamp`/`shareid`/`uk` quadruple from an embedded state blob.
  This step also detects a password gate before spending any further budget.
- **The signed strategy** sends the scraped `jsToken` (and signature, when
  present) on the `/share/list` call.
- **The anonymous strategy** sends the exact same request with those fields
  stripped.
- **The WAP strategy** doesn't reuse the page context at all — it fetches
  `/wap/share/filelist` fresh, with a mobile User-Agent, and pulls the file
  list and share record out of that page's own `__INITIAL_STATE__` blob via a
  string-aware, depth-limited object-graph search (`collectRawFiles` /
  `extractShareRecord` in `src/lib/terabox-parse.ts`) — deliberately shape-
  agnostic, because this payload has been restructured before and a rigid
  path like `state.file_list.list` breaks on the first change.

If the signed strategy can't even scrape a `jsToken`, it's skipped outright
rather than attempted and left to fail — there's no point spending a call on
a request that's certain to be rejected.

### Getting the signature (`hydrateShare`)

Listing a share and being able to _download_ it are separate things. Fresh
download links and HLS manifests are signed with the share's
`shareid`/`uk`/`sign`/`timestamp`, and any strategy can return files without
them. So when a resolve succeeds unsigned, `hydrateShare` makes one more attempt,
in order:

1. `/share/tplconfig?fields=sign,timestamp` — tried first, and only, when
   `shareid`/`uk` are already known (the normal case: the listing itself
   usually carries them even when it can't carry a signature). This is a
   single unauthenticated call for just the missing pair, needs no `jsToken`,
   and is the same call AList/OpenList's `baidu_share` driver uses against
   the identical Baidu-lineage share API — it succeeds on some shares where
   `shorturlinfo` below is walled, because it isn't gated behind a token
   check at all. Its result is paired with the already-known `shareid`/`uk`:
   safe, because the signature is a function of the share's `surl` and a
   server timestamp, not of which request carried the id fields.
2. `/api/shorturlinfo` — with the page `jsToken` if there is one, then without
   it, on each mirror in turn. Increasingly answers `errno 400210` ("need
   verify_v2") for anonymously-resolved shares, which is why step 1 exists.
3. The mobile share page's embedded state (and, if that supplied a `jsToken` we
   lacked, one more `shorturlinfo` call with it).

Steps 2 and 3 take their record whole from whichever source succeeds — `sign`
and `timestamp` are only valid as a pair _from those endpoints_, where the
same response also supplies `shareid`/`uk`. If nothing works the share is
returned as it was, and `/stream` / `/hls` retry the lookup on demand
(writing the result back to the cache) before giving up.

### Errno handling

TeraBox's `errno` values are mapped centrally in
`src/lib/errors.ts::fromTeraboxErrno`, in three families:

- **Terminal** — `-9`/`-12`/`-21` (password required/rejected), `105`/`-3`
  (share deleted). These stop the whole resolution immediately; no other
  strategy or mirror will produce a different answer, so continuing would
  just waste budget.
- **Retryable-elsewhere** — most other codes. The current strategy or mirror
  gives up, but the next one is tried.
- **CAPTCHA wall** — `400210`/`460020` (`"need verify_v2"`). Mapped to
  `verification_required` (`503`), not treated as fatal, since it's a known
  transient condition — this is the exact failure mode that made the
  single-strategy predecessor of this design stop working.

When every strategy fails, the _most actionable_ error is surfaced, not the
last one to run (`moreInformative` in `src/lib/terabox.ts`). Concretely: if
the WAP page returns a bare `403` after the signed and anonymous paths both
hit a CAPTCHA wall, the caller sees `verification_required` — an error they
can act on — rather than "WAP page returned status 403," which explains
nothing.

## The subrequest budget

Cloudflare Workers on the free plan allow 50 external subrequests per
incoming request (1,000 on paid). Every upstream call this worker makes —
resolving the share page, each listing call, each mirror retry, each folder
recursion, the eventual CDN fetch — draws from one shared `Budget` instance
(`src/lib/budget.ts`), capped at 40 to leave headroom for the response stream
itself and for a possible re-resolve.

This matters because a naive design that gives each _feature_ its own
independent cap can still blow the platform ceiling in combination — e.g. 25
folder-recursion calls × 3 retries each is 75, over budget on its own before
a single mirror fallback or CDN fetch happens. Centralizing the budget is
what makes `budget_exhausted` a graceful, typed `503` instead of Cloudflare's
own opaque `Error 1102`.

Folder recursion (`expandFolders`) checks `budget.canAfford(2)` before
descending into a subdirectory — reserving headroom for one more call even as
the budget gets tight — and marks the result `truncated: true` rather than
throwing when it has to stop early. A single unreadable subfolder doesn't
sink the rest of the listing either; that one branch is marked truncated and
the walk continues.

## dlink expiry and self-healing

TeraBox's signed download URLs (`dlink`) are short-lived — commercial
competitors in this space explicitly document this. A resolved share is
cached for well under a typical `dlink`'s lifetime specifically to keep this
rare in practice (see below), but it can still happen: a `stream_url` a
client saved from an earlier `/api/resolve` call, used later, will find the
`dlink` behind it expired.

`handleStream` (`src/handlers.ts::openUpstream`) treats a `403` or `410` from
the CDN as a signal to recover, not a final answer: it drops the cache entry
for that share, re-resolves it (an `fs_id`-preserving re-resolve, so it picks
out the same file from the fresh listing), and retries the fetch once with
the newly-signed link before giving up. This is also why `/share/download`
(`freshDownloadLink`) exists as its own function — the documented mechanism
for minting a new signed URL for one file without re-walking an entire
folder share.

## Caching

One cache tier, not two. `src/lib/cache.ts` uses Workers KV when a namespace
is bound (`CACHE` in `wrangler.toml`), so every isolate sees one consistent
entry; without KV it falls back to a per-isolate in-memory `Map`, which is
fine for personal, low-traffic use but won't be consistent across isolates.

The TTL (`CACHE_TTL`, default 1800s / 30 minutes) is deliberately set well
under the typical `dlink` lifetime — the goal is for the cache to expire
_before_ the signed URLs inside it do, so the self-healing path above is a
rare fallback rather than the normal case.

Cache keys are built from the share id and whether a password was supplied
(`shareCacheKey`), never from the raw link — share links carry wildly
varying tracking parameters and locale query strings that would otherwise
defeat caching entirely. Password-unlocked listings get a distinct key from
public ones, so an unlocked file list is never served to a caller who didn't
supply the password.

## Security properties

Two proxy endpoints (`/stream`, `/segment`) fetch content on the caller's
behalf. Neither accepts a caller-supplied destination URL — see
`SECURITY.md` for the full reasoning and the specific attack each guard
closes.

## Supported domains

TeraBox operates under many mirror domains for regional and load-balancing
reasons. The share-link allowlist (`SHARE_DOMAINS` in `src/lib/validate.ts`)
covers all of them: `terabox.com`, `terabox.app`, `terabox.club`,
`teraboxapp.com`, `teraboxlink.com`, `teraboxshare.com`, `terasharelink.com`,
`terasharefile.com`, `terafileshare.com`, `terabox1.com`, `terabox2.com`,
`1024terabox.com`, `1024tera.com`, `4funbox.com`, `4funbox.co`,
`mirrobox.com`, `nephobox.com`, `momerybox.com`, `tibibox.com`,
`freeterabox.com`, `gibibox.com`, `box-links.com`, and any subdomain of these
(so `www.`, `dm.`, etc. all work). The resolver additionally sweeps four
mirror _origins_ (`MIRROR_ORIGINS`) when making its own API calls, regardless
of which domain the original share link used — a share opened via
`terabox.app` may still resolve its listing through `www.terabox.com` if that
mirror answers and the first doesn't.
