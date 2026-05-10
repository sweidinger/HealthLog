# Phase A7 + A8a — Wave-A bucket-4 report

Status: complete on origin/main.
Last update: 2026-05-09T23:38+02:00.
Commits: source for A7 inside `9b01c86` (cross-agent race), A8a as
`2da0703 fix(geo): preserve umlauts in city names (login-overview no
longer renders "Nrnberg")`.

## A7 — AI Generator rate-limit 10/h + cache-invalidate-on-new

Two coupled fixes for the comprehensive-insight surface:

1. **Rate-limit raise.** The previous P13 limit was a hard-coded
   `2 / hour`, too aggressive when a user iterates on settings or
   regenerates after adding measurements. New default `10 / hour`,
   env-configurable via `INSIGHTS_RATE_LIMIT_PER_HOUR`. Sub-1, NaN, or
   missing values fall back to the default — operators can dial it
   down without redeploys, but a typo can never silently disable the
   limit. Documented in `.env.example`. Unit-test pin: 10 successes
   then a 429 with the message `Maximum 10 insight generations per
hour.`; same harness for the env override (3-limit smoke test) and
   the fallback paths.

2. **Per-status cache invalidation.** Marc reported "stale cached
   insights from hours ago" — root cause was that `/api/insights/
generate` only writes the `User.insightsCachedText` blob, while the
   per-scope status routes (`general-status`, `blood-pressure-status`,
   `weight-status`, `pulse-status`, `bmi-status`, `mood-status`,
   `medication-compliance-status`) cache their text in `audit_logs`
   rows keyed `insights.<scope>-status.<locale>` with a per-day
   `dateKey` floor. So a force-regeneration repainted the dashboard
   insight card but left the insights-page status cards on yesterday's
   text until midnight Berlin time. New `evictPerStatusInsightCache()`
   helper drops every `insights.*-status.*` row for the user after a
   successful generation; the `insights.generate` and
   `insights.settings.*` audit rows are preserved. The frontend was
   already correct: `insights-card.tsx` invalidates `["insights"]` via
   `queryClient.invalidateQueries` on mutation success, which covers
   every consumer in `query-keys.ts`.

i18n strings flattened to drop the hard-coded "2": both `de` and `en`
now render "you've hit the hourly limit for analyses" / "du hast das
stündliche Limit für Analysen erreicht" so the message stays correct
regardless of the configured ceiling.

Cross-agent commit race: bucket-3's A6 worker pushed `9b01c86` while
A7 had its files staged but uncommitted; the A6 commit absorbed
A7's `route.ts`, `route.test.ts`, and `.env.example` diffs verbatim.
The code is on `origin/main` and tested. Marc's audit feed will pick
this up under the medication-chart commit message — flagged here so
the v1.4.16 release summary attributes A7 correctly.

## A8a — Umlaute encoding bug ("Nrnberg" → "Nürnberg")

ipwho.is and the ip-api fallback both return UTF-8 with proper
umlauts on the wire (verified by direct curl probes against
`Düsseldorf`, `Güstrow`, `Hürth`, etc. — all came back intact).
`AuditLog.location` is `String?` in Prisma 7 against PostgreSQL 16
which is UTF-8 by default. The render path in
`login-overview-section.tsx` is a straight pass-through. So the
corruption that produced "Nrnberg" had to be somewhere in the
fetch-decode-store edge. Two defensive fixes in `lib/geo.ts`, both
tested:

1. **Explicit UTF-8 decode.** `Response.json()` defers its charset
   decision to the upstream `Content-Type: application/json;
charset=…` header. An intermediate proxy that strips or rewrites
   that parameter (Cloudflare-on-Cloudflare, a corporate proxy in
   transit, etc.) could leave the byte stream UTF-8 while the parser
   thinks it's latin-1, which is exactly the failure mode that drops
   the U+00FC continuation byte and produces "Nrnberg" out of
   "Nürnberg". The helper now reads via `arrayBuffer()` plus
   `new TextDecoder("utf-8").decode()`, then `JSON.parse`. Malformed
   bytes surface as a parse failure (caught), not silent character
   loss.

2. **Accept-Language hint.** `Accept-Language: de, en;q=0.5` on the
   lookup request. ipwho.is and ip-api both honour it; without the
   hint, ip-api falls back to the English ASCII fold ("Nuremberg"
   instead of "Nürnberg"). German first because the user-base is
   DACH-skewed; English at q=0.5 as a graceful fallback for cities
   that don't have a German name.

Wider audit of `src/` for ASCII-fold patterns: `git grep` for
`normalize("NF`, slugify calls, `String.fromCharCode` deburr, and
`[^a-zA-Z0-9]/g` strips returned zero hits. The geo helper was the
only surface that needed work.

Regression tests: 7 known-umlaut cities round-trip through the helper
(Nürnberg, München, Düsseldorf, Köln, Würzburg, Bückeburg,
Weißenfels), plus a Content-Type-without-charset case to lock in the
explicit UTF-8 decode, plus an Accept-Language header assertion. The
existing 5 tests were upgraded from `{ json: async () => obj }` fakes
to real `Response` objects so they exercise the new arrayBuffer path.

## Verification

- `pnpm test` → 1090 / 1090 passing (was 1074; 14 new from A7 + A8a +
  the medication-chart commit's 2 unrelated tests).
- `pnpm test:integration` → 35 / 35 passing.
- `pnpm typecheck` → clean.
- `pnpm lint` → 0 errors, 12 pre-existing warnings (unchanged).
- `pnpm format` → no diff after the commit.
