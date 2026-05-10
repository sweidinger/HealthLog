# Phase v1.4.17 — hotfix report

Date: 2026-05-10T~07:55+00:00.
Triggered by Marc's production crash 2026-05-10T07:38:55Z.

## Root cause

`/insights` crashed with `TypeError: Cannot read properties of undefined
(reading 'replace')` for users with cached insight blobs persisted
before the v1.4.16 strict insight schema landed.

Marc's actual cached payload (pulled from production DB):

```json
{
  "changed": "Long-term improvement on weight and BP...",
  "stable": "Pulse remains stable...",
  "drivers": "Weight reduction may have contributed...",
  "nextSteps": "Keep going.",
  "confidence": "hoch",
  "limitations": "Correlations don't imply causation..."
}
```

This is the v1.4.14 pre-strict shape — no `summary`, no
`recommendations[]`, no `findings[]`, no `dataQuality`. The
`/api/insights/generate` route's `safeParse(insightResultSchema)`
failed validation and the route's `validated.success ? validated.data :
parsed` clause fell through to the raw blob unchanged. The blob
reached the polished `<InsightAdvisorCard>` (newly mounted on
`/insights` per v1.4.16's C1 wire-up) with `summary === undefined`.

## The actual `.replace()` call site

`src/lib/insights/chart-tokens.ts:61` — `stripChartTokens(text)`:

```ts
export function stripChartTokens(text: string): string {
  return text
    .replace(TOKEN_REGEX, "")  // ← crash here when text === undefined
    .replace(/\s{2,}/g, " ")
    .trim();
}
```

Caller: `src/components/insights/insight-advisor-card.tsx:511` —
`<p>{stripChartTokens(insight.summary)}</p>`.

## Why the existing legacy-payload guard didn't fire

`isLegacyInsightPayload()` only flagged blobs whose `recommendations[]`
contained string-recs or recs missing rationale. Marc's blob has no
`recommendations` field at all, so the guard returned `false`, the API
surfaced `legacyPayload: false`, and the rich card tried to render the
v1.4.14 shape.

## Audit findings — codebase-wide `.replace()` audit

82 `.replace(...)` hits in `src/`. Categories:

- **Safe (string-typed input or runtime-string)**: 81 hits. All
  `t(...).replace(...)` (i18n returns string), `.toISOString()
  .replace(...)`, `.toLowerCase().replace(...)`, server-side string
  columns from Prisma (NOT NULL).
- **Crash-on-undefined**: 1 — the production bug. No analogous
  fragile patterns elsewhere.

Severity:

| Class | Count |
|---|---|
| Production crash sites found | 1 |
| Already-guarded patterns worth strengthening | 0 |
| New crash-on-undefined risks elsewhere | 0 after this hotfix |

Detailed audit: `.planning/v1417-replace-audit.md`.

## Fixes

1. **`src/lib/insights/chart-tokens.ts`** — `stripChartTokens()` and
   `parseChartTokens()` accept `string | null | undefined` and return
   empty string / empty array on non-string input. The defensive
   contract keeps the rich-card render path alive long enough for the
   legacy CTA above it to surface.

2. **`src/lib/ai/legacy-payload.ts`** — `isLegacyInsightPayload()` now
   flags blobs missing both `summary` AND `recommendations[]` (the
   v1.4.14 pre-strict shape). The API surfaces the right
   `legacyPayload: true` flag from a cache hit.

3. **`src/components/insights/insight-advisor-card.tsx`** — added an
   `isUnrenderable` short-circuit (`typeof insight.summary !==
   "string" || !Array.isArray(insight.findings) ||
   !Array.isArray(insight.recommendations)`) before the rich-card
   render path. The legacy / malformed blob now hits a self-contained
   regenerate-CTA card instead of trying to render the v1.4.14 shape.
   Belt-and-suspenders alongside the `legacyPayload` flag.

## TDD

The new test in `insight-advisor-card.test.tsx` reproduces Marc's
exact production scenario (the `{changed, stable, drivers,
nextSteps, confidence, limitations}` blob fed through
`<InsightAdvisorCard>`). RED before the fix (same `Cannot read
properties of undefined (reading 'replace')` error). GREEN after.

## Verification

- `pnpm typecheck` — 0 errors
- `pnpm lint` — 0 errors / 12 pre-existing warnings
- `pnpm test` — 1547/1547 (was 1540 in v1.4.16; +7 net: 4 chart-tokens
  defensive + 2 legacy-payload + 1 advisor-card)
- `pnpm test:integration` — 59/59

## Commits

| Commit | Message |
|---|---|
| `79bfa27` | `fix(insights): handle legacy cached payload without rationale (regenerate CTA)` |
| `adab80a` | `chore(release): v1.4.17` |
| `da7070e` | `style(insights): prettier sweep on legacy-payload hotfix files` |

Tag `v1.4.17` pushed.

## Why v1.4.17 instead of v1.4.16.1

Marc's instinct said "1.4.16.1", but semver requires exactly three
numeric segments. pnpm/npm tooling rejects four-segment versions
outright (`pnpm pkg get version` round-trip fails). The standard
semver-equivalent of "patch on top of v1.4.16" is `v1.4.17`. The
crash that triggered this release is small enough to absorb the
patch-bump without surprising users.

## Deploy state

(Filled in after release ships — pre-snapshot DIGEST_BEFORE captured
in shell scrollback.)

DIGEST_BEFORE (v1.4.16): `sha256:05f8a126d63962d9a4af4769de830d3fee022d634787e811b4339ee464420daa`

DIGEST_AFTER, deploy timestamp, /api/version transition, /insights
smoke status, GH release URL: appended below by the deploy verification
step.

## Deploy verification (2026-05-10T~07:58Z)

- **DIGEST_BEFORE** (v1.4.16): `sha256:05f8a126d63962d9a4af4769de830d3fee022d634787e811b4339ee464420daa`
- **DIGEST_AFTER** (v1.4.17): `sha256:936e9cf25b2d8e75d70a7912a42c8b0647e374ece036eb451676d0be9cd120ce`
- **Force pull**: `docker compose pull app && docker compose up -d app` from `/data/coolify/applications/pg8wggwogo8c4gc4ks0kk4ss` on `apps-01` (Coolify auto-deploy did fire before image was ready, hence manual pull was required).
- **/api/version transition**: `1.4.16` -> `1.4.17` confirmed live at `2026-05-10T09:58:12+02:00` (07:58:12Z).
- **/insights smoke** (the route that crashed): **HTTP 200** with logged-in session cookie. Crash fixed.
- **Broader smoke** (logged-in session):
  - `/` -> 200
  - `/dashboard` -> 404 (expected — no such route)
  - `/insights` -> 200
  - `/admin` -> 200
  - `/admin/users` -> 200
  - `/settings/ai` -> 200
- **GH release**: https://github.com/MBombeck/HealthLog/releases/tag/v1.4.17

Status: **live**.

