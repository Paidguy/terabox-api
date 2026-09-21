import { Budget, readJson } from "./budget";
import { withUnlockKey } from "./cookies";
import { ApiError, ErrorCode, fromTeraboxErrno, isStaleTokenErrno } from "./errors";
import { log } from "./log";
import {
  collectRawFiles,
  extractJsToken,
  extractLogId,
  extractShareRecord,
  isDirectory,
  looksPasswordProtected,
  looksVerificationWalled,
  makeLogId,
  mapFile,
  parseInitialState,
  type RawFile,
  type ShareRecord,
} from "./terabox-parse";
import { MIRROR_ORIGINS, extractShareId, shareIdVariants } from "./validate";
import type { TeraboxFile, TeraboxShare } from "../types";

/** Hard cap on files returned, so a huge shared drive can't blow the response. */
export const MAX_FILES = 200;
/** How many directories deep a folder share is walked. */
const MAX_DIR_DEPTH = 3;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36";

const BASE_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent": BROWSER_UA,
};

/** Headers for fetching file bytes from TeraBox's CDN. */
export const DOWNLOAD_HEADERS: Record<string, string> = {
  "User-Agent": BROWSER_UA,
  Referer: "https://www.terabox.com/",
};

interface ListResponse {
  list?: RawFile[];
  errno?: number;
  errmsg?: string;
  share_id?: number | string;
  uk?: number | string;
  sign?: string;
  timestamp?: number | string;
}

interface VerifyResponse {
  errno?: number;
  errmsg?: string;
  randsk?: string;
}

/** `/api/shorturlinfo` — the endpoint the web player reads the share record from. */
interface ShortUrlInfoResponse {
  errno?: number;
  errmsg?: string;
  shareid?: number | string;
  share_id?: number | string;
  uk?: number | string;
  sign?: string;
  timestamp?: number | string;
}

/** `/share/tplconfig?fields=sign,timestamp` — a minimal sign/timestamp mint. */
interface TplConfigResponse {
  errno?: number;
  errmsg?: string;
  data?: { sign?: string; timestamp?: number | string };
}

/**
 * `/share/download` has answered in more than one shape over time: a list of
 * `{ dlink }` objects, a bare string, or (Baidu-style) a `list`/`info` array.
 */
interface DownloadResponse {
  errno?: number;
  errmsg?: string;
  dlink?: string | { dlink?: string }[];
  list?: { dlink?: string }[];
  info?: { dlink?: string }[];
}

/** Everything gathered from the share page before the listing call. */
export interface ShareContext {
  shareId: string;
  origin: string;
  resolvedUrl: string;
  jsToken: string;
  logId: string;
  record: ShareRecord;
  cookie: string;
  html: string;
  /**
   * The page is a password gate rather than a listing. Reported, not thrown:
   * whether that's an error depends on whether the caller supplied a password,
   * which only `resolveShare` knows.
   */
  passwordGate: boolean;
}

export interface ResolveOptions {
  password?: string | undefined;
}

function listParams(context: ShareContext, shareId: string, dir?: string): URLSearchParams {
  const params = new URLSearchParams({
    app_id: "250528",
    web: "1",
    channel: "dubox",
    clienttype: "0",
    "dp-logid": context.logId,
    page: "1",
    num: "1000",
    by: "name",
    order: "asc",
    site_referer: context.resolvedUrl,
    shorturl: shareId,
  });

  if (context.jsToken) params.set("jsToken", context.jsToken);
  if (context.record.sign) params.set("sign", context.record.sign);
  if (context.record.timestamp) params.set("timestamp", context.record.timestamp);
  if (context.record.shareNumericId) params.set("shareid", context.record.shareNumericId);
  if (context.record.uk) params.set("uk", context.record.uk);

  if (dir) params.set("dir", dir);
  else params.set("root", "1");

  return params;
}

/**
 * Load the share page and harvest tokens.
 *
 * The landing fetch follows redirects, so a single request covers short-link
 * expansion and the page HTML together.
 */
export async function openShare(
  link: string,
  cookie: string,
  budget: Budget,
): Promise<ShareContext> {
  const response = await budget.fetch(link, {
    headers: { ...BASE_HEADERS, Cookie: cookie },
    redirect: "follow",
  });

  if (response.status === 404 || response.status === 410) {
    throw ApiError.notFound("That share link doesn't exist or has been deleted.");
  }
  if (!response.ok) {
    throw ApiError.upstream(`Failed to open the share link (status ${response.status}).`, {
      status: response.status,
    });
  }

  const resolvedUrl = response.url || link;
  const html = await response.text();

  let shareId: string | null = null;
  for (const candidate of [resolvedUrl, link]) {
    try {
      shareId = extractShareId(new URL(candidate));
    } catch {
      shareId = null;
    }
    if (shareId) break;
  }
  if (!shareId) {
    throw ApiError.upstreamUnexpected(
      "Could not find a share id on that link. Check the URL was copied in full.",
    );
  }

  return {
    shareId,
    origin: new URL(resolvedUrl).origin,
    resolvedUrl,
    jsToken: extractJsToken(html),
    logId: extractLogId(html),
    record: extractShareRecord(html),
    cookie,
    html,
    passwordGate: looksPasswordProtected(html),
  };
}

/** Exchange a share password for the `randsk` unlock key. */
export async function unlockShare(
  context: ShareContext,
  password: string,
  budget: Budget,
): Promise<string> {
  const params = new URLSearchParams({
    surl: context.shareId.replace(/^1/, ""),
    t: String(Date.now()),
    channel: "dubox",
    web: "1",
    app_id: "250528",
    clienttype: "0",
    "dp-logid": context.logId,
  });
  if (context.jsToken) params.set("jsToken", context.jsToken);

  const response = await budget.fetch(`${context.origin}/share/verify?${params}`, {
    method: "POST",
    headers: {
      ...BASE_HEADERS,
      Cookie: context.cookie,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: context.resolvedUrl,
    },
    body: new URLSearchParams({ pwd: password, vcode: "", vcode_str: "" }).toString(),
  });

  const data = await readJson<VerifyResponse>(response, "verifying the share password");

  if (data.errno) {
    if (data.errno === -9 || data.errno === -12 || data.errno === -21) {
      throw ApiError.passwordRequired("That password was rejected by TeraBox.");
    }
    throw fromTeraboxErrno(data.errno, data.errmsg);
  }
  if (!data.randsk) {
    throw ApiError.upstreamUnexpected("TeraBox accepted the password but returned no unlock key.");
  }
  return data.randsk;
}

/**
 * One `share/list` call, tried across mirrors and both share-id spellings.
 *
 * `anonymous` drops the jsToken and signature. Counter-intuitively that
 * sometimes succeeds where the signed call is CAPTCHA-walled, which is why it
 * exists as its own path rather than as an error branch.
 */
async function callList(
  context: ShareContext,
  cookie: string,
  budget: Budget,
  options: { anonymous: boolean; dir?: string },
): Promise<{ files: RawFile[]; record: ShareRecord }> {
  const origins = [context.origin, ...MIRROR_ORIGINS.filter((o) => o !== context.origin)];
  const ids = shareIdVariants(context.shareId);
  let lastError: ApiError | null = null;

  const effectiveContext: ShareContext = options.anonymous
    ? { ...context, jsToken: "", record: { shareNumericId: "", uk: "", sign: "", timestamp: "" } }
    : context;

  for (const origin of origins) {
    for (const id of ids) {
      if (!budget.canAfford()) {
        throw lastError ?? ApiError.budgetExhausted();
      }

      const params = listParams(effectiveContext, id, options.dir);
      let data: ListResponse;

      try {
        const response = await budget.fetch(`${origin}/share/list?${params}`, {
          headers: { ...BASE_HEADERS, Cookie: cookie, Referer: context.resolvedUrl },
          retries: 0,
        });
        data = await readJson<ListResponse>(response, "listing the share contents");
      } catch (err) {
        lastError = err instanceof ApiError ? err : ApiError.upstream(String(err));
        continue;
      }

      if (data.errno) {
        lastError = fromTeraboxErrno(data.errno, data.errmsg);
        // A password gate or a missing share is final — no mirror will differ.
        if (
          lastError.code === ErrorCode.PASSWORD_REQUIRED ||
          lastError.code === ErrorCode.NOT_FOUND
        ) {
          throw lastError;
        }
        continue;
      }

      if (!data.list || data.list.length === 0) {
        lastError = new ApiError(
          ErrorCode.EMPTY_SHARE,
          "This share contains no downloadable files.",
          404,
        );
        continue;
      }

      return {
        files: data.list,
        record: {
          shareNumericId: data.share_id === undefined ? "" : String(data.share_id),
          uk: data.uk === undefined ? "" : String(data.uk),
          sign: data.sign ?? "",
          timestamp: data.timestamp === undefined ? "" : String(data.timestamp),
        },
      };
    }
  }

  throw lastError ?? ApiError.upstream("TeraBox returned no usable listing.");
}

/**
 * Last-resort strategy: scrape the mobile share page.
 *
 * The WAP page embeds the share record and signed download links in its HTML,
 * so it keeps working when the JSON endpoints are behind the CAPTCHA wall.
 * It's placed last because its payload shape is the least stable of the three.
 */
async function callWap(
  context: Pick<ShareContext, "shareId" | "origin">,
  cookie: string,
  budget: Budget,
): Promise<{ files: RawFile[]; record: ShareRecord }> {
  const surl = context.shareId.replace(/^1/, "");
  const origins = [context.origin, ...MIRROR_ORIGINS.filter((o) => o !== context.origin)];
  let lastError: ApiError | null = null;

  for (const origin of origins) {
    if (!budget.canAfford()) break;

    try {
      const response = await budget.fetch(
        `${origin}/wap/share/filelist?surl=${encodeURIComponent(surl)}`,
        {
          headers: { ...BASE_HEADERS, "User-Agent": MOBILE_UA, Cookie: cookie },
          redirect: "follow",
          retries: 0,
        },
      );

      if (!response.ok) {
        lastError = ApiError.upstream(`WAP page returned status ${response.status}.`);
        continue;
      }

      const html = await response.text();
      const state = parseInitialState(html);
      const files = collectRawFiles(state).filter((file) => !isDirectory(file));

      if (files.length === 0) {
        // Only now is the wall keyword meaningful. Checked first it misfires:
        // a page that lists files can still mention "captcha" in its scripts.
        if (looksVerificationWalled(html)) {
          lastError = ApiError.verificationRequired();
          continue;
        }
        lastError = new ApiError(
          ErrorCode.EMPTY_SHARE,
          "The mobile share page listed no files.",
          404,
        );
        continue;
      }

      return { files, record: extractShareRecord(state) };
    } catch (err) {
      lastError = err instanceof ApiError ? err : ApiError.upstream(String(err));
    }
  }

  throw lastError ?? ApiError.upstream("The mobile share page could not be read.");
}

/**
 * Walk a share breadth-first, expanding directories so a folder link returns
 * real files instead of one unusable directory entry.
 *
 * Bounded by depth, the file cap, and — most importantly — the shared
 * subrequest budget, which is what keeps a deep folder from exceeding the
 * platform's per-request ceiling.
 */
async function expandFolders(
  context: ShareContext,
  cookie: string,
  budget: Budget,
  anonymous: boolean,
  rootEntries: RawFile[],
): Promise<{ files: TeraboxFile[]; truncated: boolean }> {
  const files: TeraboxFile[] = [];
  let truncated = false;

  let frontier = rootEntries.map((entry) => ({ entry, depth: 0 }));

  while (frontier.length > 0) {
    const next: { entry: RawFile; depth: number }[] = [];

    for (const node of frontier) {
      if (!isDirectory(node.entry)) {
        if (files.length >= MAX_FILES) {
          truncated = true;
          continue;
        }
        files.push(mapFile(node.entry));
        continue;
      }

      const path = node.entry.path;
      // Leave one call spare so a later fresh-dlink lookup can still run.
      if (!path || node.depth >= MAX_DIR_DEPTH || !budget.canAfford(2)) {
        truncated = true;
        continue;
      }

      try {
        const listing = await callList(context, cookie, budget, { anonymous, dir: path });
        next.push(...listing.files.map((entry) => ({ entry, depth: node.depth + 1 })));
      } catch {
        // One unreadable subfolder shouldn't sink the whole listing.
        truncated = true;
      }
    }

    frontier = next;
  }

  return { files, truncated };
}

/**
 * True once a record carries all four fields TeraBox's download and streaming
 * endpoints want signed. Takes a bare record or a whole share — they share
 * these field names.
 */
export function hasSignature(record: {
  shareNumericId: string;
  uk: string;
  sign: string;
  timestamp: string;
}): boolean {
  return Boolean(record.shareNumericId && record.uk && record.sign && record.timestamp);
}

function stringify(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/**
 * Ask `/api/shorturlinfo` for the share record.
 *
 * This is where the web player gets `shareid` / `uk` / `sign` / `timestamp`
 * from. `/share/list` doesn't reliably repeat them, and the share page itself
 * is a client-rendered shell that often embeds none — which is how a share can
 * list fine and still be impossible to download from.
 *
 * The endpoint is fickle about tokens: some builds want the page `jsToken`,
 * others answer anonymously and wall the tokened call. So each origin is tried
 * with the token and then without it.
 */
async function callShortUrlInfo(
  share: TeraboxShare,
  cookie: string,
  jsToken: string,
  budget: Budget,
): Promise<ShareRecord | null> {
  const origins = [share.origin, ...MIRROR_ORIGINS.filter((o) => o !== share.origin)];
  const tokens = jsToken ? [jsToken, ""] : [""];

  for (const origin of origins) {
    for (const token of tokens) {
      // Keep one call spare for the download request this is in service of.
      if (!budget.canAfford(2)) return null;

      const params = new URLSearchParams({
        app_id: "250528",
        web: "1",
        channel: "dubox",
        clienttype: "0",
        "dp-logid": makeLogId(),
        page: "1",
        num: "20",
        by: "name",
        order: "asc",
        site_referer: share.resolvedUrl,
        shorturl: share.shareId,
        root: "1",
      });
      if (token) params.set("jsToken", token);

      try {
        const response = await budget.fetch(`${origin}/api/shorturlinfo?${params}`, {
          headers: { ...BASE_HEADERS, Cookie: cookie, Referer: share.resolvedUrl },
          retries: 0,
        });
        const data = await readJson<ShortUrlInfoResponse>(response, "reading the share record");
        if (data.errno) continue;

        const record: ShareRecord = {
          shareNumericId: stringify(data.shareid ?? data.share_id),
          uk: stringify(data.uk),
          sign: stringify(data.sign),
          timestamp: stringify(data.timestamp),
        };
        if (hasSignature(record)) return record;
      } catch {
        // A walled, blocked or malformed answer from one origin says nothing
        // about the others.
      }
    }
  }
  return null;
}

/**
 * Ask `/share/tplconfig` for just the `sign`/`timestamp` pair.
 *
 * This is the call TeraBox and Baidu's own share clients use to mint a fresh
 * signature from nothing but the `surl` — confirmed against the open-source
 * AList/OpenList "baidu_share" driver, which is the same Baidu-lineage share
 * API TeraBox is built on. Unlike `/api/shorturlinfo` it needs no `jsToken`
 * and returns nothing else, so it succeeds in some cases where the heavier,
 * more commonly-walled `shorturlinfo` lookup is CAPTCHA-gated (`errno
 * 400210`, "need verify_v2"). It cannot supply `shareid`/`uk` on its own —
 * only the caller's `surl` goes in — so it is only useful once those two are
 * already known from the listing itself, which is the common case.
 */
async function callTplConfig(
  share: Pick<TeraboxShare, "origin" | "shareId">,
  cookie: string,
  budget: Budget,
): Promise<{ sign: string; timestamp: string } | null> {
  const surl = share.shareId.replace(/^1/, "");
  const origins = [share.origin, ...MIRROR_ORIGINS.filter((o) => o !== share.origin)];
  // "dubox" matches the channel every other call in this file signs with;
  // "chunlei" is what the known-working reference implementation uses and is
  // tried as a fallback in case the same anti-bot wall is channel-specific.
  const channels = ["dubox", "chunlei"];

  for (const origin of origins) {
    for (const channel of channels) {
      if (!budget.canAfford()) return null;

      const params = new URLSearchParams({
        fields: "sign,timestamp",
        channel,
        web: "1",
        app_id: "250528",
        clienttype: "0",
        surl,
      });

      try {
        const response = await budget.fetch(`${origin}/share/tplconfig?${params}`, {
          headers: { ...BASE_HEADERS, Cookie: cookie, Referer: `${origin}/s/${share.shareId}` },
          retries: 0,
        });
        const data = await readJson<TplConfigResponse>(response, "reading the share signature");
        if (data.errno) continue;

        const sign = stringify(data.data?.sign);
        const timestamp = stringify(data.data?.timestamp);
        if (sign && timestamp) return { sign, timestamp };
      } catch {
        // Try the next channel/mirror; one failure says nothing about another.
      }
    }
  }
  return null;
}

/**
 * The mobile share page, read for its embedded share record and — for callers
 * that still lack one — a page token. One call, one origin: this is a
 * supplement to `callShortUrlInfo`, not another full sweep.
 */
async function readWapRecord(
  share: TeraboxShare,
  cookie: string,
  budget: Budget,
): Promise<{ record: ShareRecord; jsToken: string } | null> {
  if (!budget.canAfford(2)) return null;

  const surl = share.shareId.replace(/^1/, "");
  try {
    const response = await budget.fetch(
      `${share.origin}/wap/share/filelist?surl=${encodeURIComponent(surl)}`,
      {
        headers: { ...BASE_HEADERS, "User-Agent": MOBILE_UA, Cookie: cookie },
        redirect: "follow",
        retries: 0,
      },
    );
    if (!response.ok) return null;

    const html = await response.text();
    return { record: extractShareRecord(html), jsToken: extractJsToken(html) };
  } catch {
    return null;
  }
}

/**
 * Fill in a share's missing signature.
 *
 * Every listing strategy can succeed without producing one, and nothing
 * downstream works without it: `freshDownloadLink` refuses to run and `/hls`
 * can't build a manifest URL. So a share that came back unsigned gets one more
 * chance here, from the three places that reliably carry it.
 *
 * `/share/tplconfig` is tried first when `shareid`/`uk` are already known
 * (the common case — the listing itself usually returns them even when it
 * can't return a signature): it's a single unauthenticated call for just the
 * missing `sign`/`timestamp` pair, and it isn't gated behind the `jsToken`
 * check that walls `/api/shorturlinfo` on some shares. Pairing its result
 * with the already-known `shareid`/`uk` is safe — TeraBox's signature is a
 * function of the share's `surl` and a server-side timestamp, not of which
 * request happened to carry the id fields alongside it, and this is exactly
 * how AList/OpenList's Baidu-share driver combines the two calls.
 *
 * Never throws and never makes things worse: the share you passed in comes
 * back untouched if nothing is found, because a listing without a signature
 * is still worth returning.
 */
export async function hydrateShare(
  share: TeraboxShare,
  cookie: string,
  budget: Budget,
): Promise<TeraboxShare> {
  const withKey = withUnlockKey(cookie, share.randsk);
  let jsToken = share.jsToken;

  try {
    if (share.shareNumericId && share.uk) {
      const pair = await callTplConfig(share, withKey, budget);
      if (pair) return { ...share, sign: pair.sign, timestamp: pair.timestamp, jsToken };
    }

    let record = await callShortUrlInfo(share, withKey, jsToken, budget);

    if (!record) {
      const wap = await readWapRecord(share, withKey, budget);
      if (wap && hasSignature(wap.record)) {
        record = wap.record;
        jsToken = jsToken || wap.jsToken;
      } else if (wap?.jsToken && !jsToken) {
        // The mobile page had no record, but it did have the token that the
        // share-info endpoint may have been refusing to answer without.
        jsToken = wap.jsToken;
        record = await callShortUrlInfo(share, withKey, jsToken, budget);
      }
    }

    // Take the record whole. The sign/timestamp pair is only valid together, so
    // it must never be stitched together from two different sources.
    if (record) return { ...share, ...record, jsToken };
  } catch (err) {
    log("warn", "share signature lookup failed", {
      share_id: share.shareId,
      code: err instanceof ApiError ? err.code : "unknown",
    });
    return share;
  }

  log("warn", "share exposed no signature", { share_id: share.shareId });
  return share;
}

type StrategyName = TeraboxShare["strategy"];

/**
 * How informative each failure is, highest first.
 *
 * When every strategy fails they each fail differently, and the last one to
 * run is rarely the most useful thing to tell the caller. A CAPTCHA wall is
 * actionable ("retry shortly"); an expired cookie is actionable ("rotate the
 * secret"); "the mobile page returned 403" is noise. So the most actionable
 * error is surfaced rather than the most recent.
 */
const ERROR_PRIORITY: string[] = [
  ErrorCode.VERIFICATION_REQUIRED,
  ErrorCode.COOKIE_INVALID,
  ErrorCode.EMPTY_SHARE,
  ErrorCode.UPSTREAM_UNEXPECTED,
  ErrorCode.UPSTREAM_UNAVAILABLE,
];

function moreInformative(candidate: ApiError, incumbent: ApiError | null): boolean {
  if (!incumbent) return true;
  const rank = (error: ApiError) => {
    const index = ERROR_PRIORITY.indexOf(error.code);
    return index === -1 ? ERROR_PRIORITY.length : index;
  };
  return rank(candidate) < rank(incumbent);
}

/**
 * Resolve a share link to its files.
 *
 * Three strategies are tried in order — signed, anonymous, then the WAP page
 * scrape. They fail in genuinely different ways (a stale token, a CAPTCHA
 * wall, a restructured payload), so trying all three is what keeps the API
 * working through TeraBox's frequent changes. Caching happens a layer up, in
 * `lib/cache.ts`, which keeps this a straightforward "go and ask" function.
 */
export async function resolveShare(
  link: string,
  cookie: string,
  budget: Budget,
  options: ResolveOptions = {},
): Promise<TeraboxShare> {
  let context = await openShare(link, cookie, budget);

  // A password gate is only a dead end when there's no password to offer.
  // (This used to throw inside `openShare`, before the password was ever
  // used — so a protected share could not be unlocked at all.)
  if (context.passwordGate && !options.password) throw ApiError.passwordRequired();

  let effectiveCookie = cookie;
  let randsk = "";
  if (options.password) {
    randsk = await unlockShare(context, options.password, budget);
    effectiveCookie = withUnlockKey(cookie, randsk);

    if (context.passwordGate) {
      // The gate page carries no token and no share record. Now that the share
      // is unlocked, load it again to get the real page.
      try {
        const unlocked = await openShare(link, effectiveCookie, budget);
        if (!unlocked.passwordGate) context = unlocked;
      } catch {
        // Carry on with what the gate page gave us; the listing can still work.
      }
    }
  }

  const strategies: {
    name: StrategyName;
    run: () => Promise<{ files: RawFile[]; record: ShareRecord }>;
  }[] = [
    { name: "signed", run: () => callList(context, effectiveCookie, budget, { anonymous: false }) },
    {
      name: "anonymous",
      run: () => callList(context, effectiveCookie, budget, { anonymous: true }),
    },
    { name: "wap", run: () => callWap(context, effectiveCookie, budget) },
  ];

  // Without a jsToken the signed call is guaranteed to fail; skip the spend.
  const usable = context.jsToken ? strategies : strategies.filter((s) => s.name !== "signed");

  let lastError: ApiError | null = null;

  for (const strategy of usable) {
    if (!budget.canAfford()) break;

    try {
      const listing = await strategy.run();
      const record = {
        shareNumericId: listing.record.shareNumericId || context.record.shareNumericId,
        uk: listing.record.uk || context.record.uk,
        sign: listing.record.sign || context.record.sign,
        timestamp: listing.record.timestamp || context.record.timestamp,
      };

      const { files, truncated } = await expandFolders(
        context,
        effectiveCookie,
        budget,
        strategy.name !== "signed",
        listing.files,
      );

      if (files.length === 0) {
        const empty = new ApiError(
          ErrorCode.EMPTY_SHARE,
          "This share contains no downloadable files.",
          404,
        );
        if (moreInformative(empty, lastError)) lastError = empty;
        continue;
      }

      const share: TeraboxShare = {
        shareId: context.shareId,
        shareNumericId: record.shareNumericId,
        uk: record.uk,
        sign: record.sign,
        timestamp: record.timestamp,
        randsk,
        jsToken: context.jsToken,
        origin: context.origin,
        resolvedUrl: context.resolvedUrl,
        files,
        passwordProtected: Boolean(options.password),
        truncated,
        strategy: strategy.name,
      };

      // Listing succeeded, but the signature may not have come with it. Fetch
      // it now, while the cookie and unlock key are to hand.
      return hasSignature(share) ? share : await hydrateShare(share, effectiveCookie, budget);
    } catch (err) {
      const apiError = err instanceof ApiError ? err : ApiError.upstream(String(err));
      // A password gate or a deleted share won't be fixed by another strategy.
      if (
        apiError.code === ErrorCode.PASSWORD_REQUIRED ||
        apiError.code === ErrorCode.NOT_FOUND ||
        apiError.code === ErrorCode.BUDGET_EXHAUSTED
      ) {
        throw apiError;
      }
      if (moreInformative(apiError, lastError)) lastError = apiError;
    }
  }

  if (lastError) throw lastError;
  if (!context.jsToken) {
    throw ApiError.cookieInvalid(
      "Could not extract a page token and every fallback failed. The TERABOX_COOKIE secret has most likely expired.",
    );
  }
  throw ApiError.upstream("Every resolution strategy failed for this share.");
}

/** Pull the link out of whichever shape `/share/download` answered in. */
function extractDlink(data: DownloadResponse): string {
  if (typeof data.dlink === "string") return data.dlink;
  return data.dlink?.[0]?.dlink || data.list?.[0]?.dlink || data.info?.[0]?.dlink || "";
}

/**
 * One `/share/download` attempt.
 *
 * `POST` is the Baidu-lineage form — signature in the query string, the file
 * selection in a form body. `GET` is the form the current web player sends,
 * with everything in the query string. Which one TeraBox is happy with has
 * changed before, so `freshDownloadLink` tries both.
 */
async function requestDownloadLink(
  share: TeraboxShare,
  file: TeraboxFile,
  cookie: string,
  budget: Budget,
  method: "POST" | "GET",
): Promise<string> {
  const params = new URLSearchParams({
    app_id: "250528",
    web: "1",
    channel: "dubox",
    clienttype: "0",
    sign: share.sign,
    timestamp: share.timestamp,
  });
  if (share.jsToken) params.set("jsToken", share.jsToken);

  const fields = new URLSearchParams({
    encrypt: "0",
    product: "share",
    uk: share.uk,
    primaryid: share.shareNumericId,
    fid_list: `[${file.fsId}]`,
  });
  if (share.randsk) fields.set("extra", JSON.stringify({ sekey: share.randsk }));

  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    Cookie: withUnlockKey(cookie, share.randsk),
    Referer: share.resolvedUrl,
  };

  let response: Response;
  if (method === "POST") {
    fields.set("type", "nolimit");
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    response = await budget.fetch(`${share.origin}/share/download?${params}`, {
      method: "POST",
      headers,
      body: fields.toString(),
    });
  } else {
    params.set("shareid", share.shareNumericId);
    params.set("dp-logid", makeLogId());
    params.set("nozip", "0");
    for (const [key, value] of fields) params.set(key, value);
    response = await budget.fetch(`${share.origin}/share/download?${params}`, { headers });
  }

  const data = await readJson<DownloadResponse>(response, "requesting a fresh download link");
  if (data.errno) {
    if (isStaleTokenErrno(data.errno)) {
      throw ApiError.cookieInvalid(
        "TeraBox rejected the signature while minting a download link. Try again; if it persists, refresh TERABOX_COOKIE.",
      );
    }
    throw fromTeraboxErrno(data.errno, data.errmsg);
  }

  const link = extractDlink(data);
  if (!link) throw ApiError.upstreamUnexpected("TeraBox returned no download link for this file.");
  return link;
}

/** Failures that would repeat identically on the other request form. */
const FINAL_DOWNLOAD_ERRORS: string[] = [
  ErrorCode.COOKIE_INVALID,
  ErrorCode.PASSWORD_REQUIRED,
  ErrorCode.NOT_FOUND,
  ErrorCode.VERIFICATION_REQUIRED,
  ErrorCode.BUDGET_EXHAUSTED,
];

/**
 * Ask TeraBox for a freshly signed download URL for one file.
 *
 * Used when the listing returned no dlink, and again when a cached dlink has
 * expired — dlinks are short-lived, and this is the documented way to renew
 * one without re-resolving the whole share.
 *
 * Needs the share's signature. A share that lacks one should go through
 * `hydrateShare` first; this function refuses rather than send a request that
 * is certain to be rejected.
 */
export async function freshDownloadLink(
  share: TeraboxShare,
  file: TeraboxFile,
  cookie: string,
  budget: Budget,
): Promise<string> {
  if (!hasSignature(share)) {
    throw ApiError.upstreamUnexpected(
      "This share did not expose the signature needed to mint a fresh download link.",
    );
  }

  let lastError: ApiError | null = null;

  for (const method of ["POST", "GET"] as const) {
    if (method === "GET" && !budget.canAfford()) break;

    try {
      return await requestDownloadLink(share, file, cookie, budget, method);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (FINAL_DOWNLOAD_ERRORS.includes(err.code)) throw err;
      lastError = err;
    }
  }

  throw lastError ?? ApiError.upstreamUnexpected("TeraBox returned no download link for this file.");
}

/**
 * Build the URL for TeraBox's own HLS manifest.
 *
 * This is what makes browser playback work for containers a `<video>` tag
 * can't handle directly, such as MKV and AVI.
 */
export function streamingManifestUrl(
  share: TeraboxShare,
  file: TeraboxFile,
  quality: string,
): string {
  const params = new URLSearchParams({
    app_id: "250528",
    channel: "dubox",
    clienttype: "0",
    web: "1",
    uk: share.uk,
    shareid: share.shareNumericId,
    fid: file.fsId,
    sign: share.sign,
    timestamp: share.timestamp,
    type: quality,
    esl: "1",
    isplayer: "1",
  });
  if (share.jsToken) params.set("jsToken", share.jsToken);
  return `${share.origin}/share/streaming?${params}`;
}

/** Pick one file out of a resolved share, by fs_id or first-by-default. */
export function selectFile(share: TeraboxShare, fsId?: string | null): TeraboxFile {
  if (!fsId) return share.files[0]!;
  const match = share.files.find((file) => file.fsId === fsId);
  if (!match) throw ApiError.notFound(`No file with fs_id '${fsId}' in this share.`);
  return match;
}
