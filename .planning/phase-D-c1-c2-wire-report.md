# Phase D — CRITICAL C1 + C2 wire-up report (v1.4.16)

Status: complete on origin/main.
Date: 2026-05-10T03:35+02:00

## C1 — Wire `<InsightAdvisorCard>` into `/insights` — **DONE**

Commit: `aae968a fix(insights): mount InsightAdvisorCard on /insights page (wire B5c/d/e + B1b polish to live route)`

The Wave-D reconcile report deferred C1 because it assumed mounting
the advisor card required either rewriting all 7 per-status
endpoints OR carving a new GET route around `User.insightsCachedText`.
Neither is true: `POST /api/insights/generate` already returns the
24h-cached payload on cache-hit without burning a rate-limit token,
so a single `POST {}` (no `force`) is functionally a GET-or-generate.

New `useInsightsAdvisorQuery()` hook in
`src/components/insights/use-insights-advisor.ts` reads the payload
under `queryKeys.insightsAdvisor()` and exposes a `regenerate()` mutation
that invalidates both the advisor cache AND the per-status
`["insights"]` subtree (so the per-section text below the card
re-fetches on regenerate).

`/insights/page.tsx` mounts `<InsightAdvisorCard>` directly under the
B1b page hero + comparison toggle, above the section-nav. Hero now
forwards its regenerate button to the same handler. The 7 per-section
`<InsightStatusCard>`s stay below as supplemental detail — the card
surface is additive, not a replacement.

E2E proof: `e2e/insights-advisor-card.spec.ts` mocks the analytics
+ comprehensive + per-status + advisor endpoints and asserts the
hero, the rec text, the ConfidenceMeter slot, and the summary prose
all render on the live `/insights` route.

## C2 — Mount `<InsightsCardPreview>` on `/` — **DONE**

Commit: `8a5b6de fix(dashboard): mount InsightsCardPreview on root page (wire B1b dashboard preview to live route)`

`InsightsCardPreview` shipped in B1b (`d2cdf9d`) but had zero non-test
imports. The dashboard read no advisor payload, so the polished
top-recommendation tile + ring ConfidenceMeter + "View all" CTA was
unreachable.

Added `insightsPreview` to `DASHBOARD_WIDGET_IDS` so the layout toggle
persists through Settings → Dashboard (mirrors the A5 widget-enum-drift
guard), pinned it into `DEFAULT_DASHBOARD_LAYOUT` (visible: true,
tileVisible: false), and added a contract test mirroring the
`achievements`-widget pattern. New i18n key `dashboard.insightsPreview`
in EN + DE.

Dashboard renders the preview between the tile-strip and the chart row,
gated by `isChartVisible("insightsPreview")`. Shares the
`useInsightsAdvisorQuery()` cache with `/insights` so a regenerate on
either surface hot-swaps the other. The preview self-hides when the
advisor payload is missing OR has no recommendations (its existing
null-render branch).

E2E proof: `e2e/insights-card-preview.spec.ts` mocks
`/api/dashboard/widgets` to enable the preview, mocks the advisor
endpoint with one urgent rec carrying confidence=82, and asserts the
preview slot, the urgent rec text, the "View all" CTA, and the inline
ConfidenceMeter all render on `/`.

## Verification

- `pnpm typecheck` — 0 errors
- `pnpm lint` — 0 errors / 12 pre-existing warnings
- `pnpm test --run` — 1540/1540 passed (was 1539, +1 for the new
  `insightsPreview` widget contract test)
- `pnpm test:integration` — 59/59 passed
- `pnpm format:check` — only pre-existing unrelated files flagged;
  my files all prettier-clean

Final commit set on origin/main:

- `aae968a` — C1 wire-up + new hook + e2e spec
- `8a5b6de` — C2 wire-up + widget enum + dashboard test + e2e spec
- `c63cddc` — prettier sweep on the two wire-up files

No deferrals. C1 + C2 are no longer ship-blockers for v1.4.16 release.
