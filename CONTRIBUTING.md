# Contributing

Thanks for considering a contribution.

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in your own TERABOX_COOKIE
npm run dev
```

## Before opening a PR

Run the full check locally — it's the same thing CI runs:

```bash
npm run check   # typecheck + lint + format:check + dry-run deploy
```

Individually:

```bash
npm run typecheck
npm run lint
npm run format       # auto-fix formatting
```

If your change touches resolution logic (`src/lib/terabox.ts`,
`src/lib/terabox-parse.ts`) or anything else that talks to TeraBox, also run
the live smoke test against a real deployment before considering it done:

```bash
node scripts/smoke.mjs https://your-worker.workers.dev "https://terabox.com/s/1EXAMPLE"
```

## Guidelines

- Keep `src/lib/*` functions pure where practical.
  `src/lib/terabox-parse.ts` and `src/lib/validate.ts` especially — they're
  the parsing and security-relevant logic respectively. Any change to the
  host allowlists (`SHARE_DOMAINS`, `DOWNLOAD_DOMAINS` in
  `src/lib/validate.ts`) should say in the PR what it now accepts and
  rejects.
- Don't reintroduce a caller-controlled URL into `/stream` or `/segment`.
  Both re-derive what they fetch from something the worker itself produced
  (a resolved share, a signed token) — see [`SECURITY.md`](SECURITY.md)
  before changing either.
- If you add a new TeraBox `errno` mapping, add it to
  `src/lib/errors.ts::fromTeraboxErrno` with a comment explaining what
  causes it. This mapping is the main
  thing standing between a real failure and a useless generic error message.
- If you touch the resolver's strategy order or fallback logic
  (`src/lib/terabox.ts::resolveShare`), read
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first — the ordering and
  the "most informative error wins" behavior are both deliberate, not
  arbitrary.
- Respect the subrequest budget. Any new code path that calls `fetch`
  against TeraBox should go through the shared `Budget` instance
  (`src/lib/budget.ts`), not a raw `fetch` — see
  [`docs/ARCHITECTURE.md#the-subrequest-budget`](docs/ARCHITECTURE.md#the-subrequest-budget)
  for why a per-feature cap isn't sufficient on its own.
- No secrets, real cookies, or personal TeraBox links in commits or issues.
- Keep PRs focused. Unrelated formatting-only diffs make review harder —
  run `npm run format` on the files you actually touched, not the whole tree,
  unless the PR is specifically a formatting pass.

## Reporting bugs

Open an issue with: the request you made (redact your cookie/link), the
`error.code` and `request_id` from the response, and what you expected. A
`wrangler tail` excerpt (secrets are already redacted before logging — see
`src/lib/log.ts`) is more useful than a description. If it's a security
issue, see [`SECURITY.md`](SECURITY.md) instead of opening a public issue.
