# Phase 4 — Performance audit (v1.5 marathon)

**Status**: done
**Finished**: 2026-05-09T16:30+02:00
**Full report**: [docs/audit/v15-performance.md](../docs/audit/v15-performance.md)

## What got measured

Standalone Playwright + PerformanceObserver script (one-shot, lives at
`/tmp/v15-perf-measure.mjs`, not committed) captured nav timing, LCP,
TBT, longtask count, full Resource Timing list and a per-response
content-length fallback (Cloudflare strips Content-Length on chunked
responses) against production (`/api/version` = `1.4.13`) at
`2026-05-09T14:14:48Z`. Marc's session cookie was injected pre-nav.
Four pages (`/`, `/settings/integrations`, `/admin`, `/insights`) each
loaded twice — `1920×1080` desktop and Pixel 5 mobile.

## Headline numbers

The dashboard is the heaviest page: 425 KiB JS, 2.83 s LCP desktop,
624 ms TBT (one longtask, dashboard hydration). `/insights` is
comparable (419 KiB JS, ~108 KiB of which is Recharts pulled in
eagerly). `/admin` and `/settings/integrations` are lean (~290 KiB JS,
< 2 s LCP). The dominant single-dependency cost everywhere is
**Recharts** (~108 KiB Brotli per chart-using page).

## Wins implemented inline

1. **`bb2b1de` — `perf(insights): defer Recharts ScatterChart imports
via next/dynamic`** — moves the seven recharts symbols (ScatterChart,
   Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer)
   off the eager imports of `src/app/insights/page.tsx` and onto
   per-symbol `next/dynamic({ ssr: false })`. Same shape as the existing
   HealthChart/MoodChart pattern in the same file.
2. **`519e36e` — `perf(dashboard): skip checklist API fetches once
onboarding is complete`** — gates the `withings/status` and
   `notifications/preferences` queries inside
   `getting-started-checklist.tsx` on
   `user.onboardingCompletedAt == null`. Saves ~950 ms of network on
   every dashboard load for established users.

The audit doc was committed in **`41fa203`**.

## Wins deferred

- **Recharts replacement** (~108 KiB savings on every chart-using
  page). Effort is L (every chart in `src/components/charts/` needs
  rewrite + a new dep). Tagged for **v1.5.1** because v1.5's no-new-deps
  hard rule blocks it.

## Not done / acknowledged

- Local `pnpm build` cannot complete on this machine due to the Node-25
  turbopack `Cannot read private member #state…` regression noted in
  `CLAUDE.md`. Verification therefore lives in static code review and
  will be re-confirmed against prod once v1.5.0 deploys.
- `pnpm typecheck` reports two errors in `e2e/mobile-viewport.spec.ts`
  (concurrent Phase 3 work) — left untouched per the "do not touch
  e2e/" constraint.
- `pnpm test` (95 files / 733 tests) and `pnpm lint` (0 errors,
  pre-existing warnings only) are clean for the files I touched.

## Files committed

- `src/app/insights/page.tsx` — recharts symbols → `next/dynamic`
- `src/components/onboarding/getting-started-checklist.tsx` — checklist
  query gating
- `docs/audit/v15-performance.md` — full audit
