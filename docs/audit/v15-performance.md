# v1.5 Performance Audit — Production

**Status**: phase-4 of the v1.5 marathon
**Measured against**: `https://healthlog.bombeck.io` (`/api/version` → `1.4.13`)
**Measured at**: `2026-05-09T14:14:48Z` → `2026-05-09T14:15:27Z`
**Tool**: standalone Playwright + Chromium 1217 driver, `PerformanceObserver`
(`largest-contentful-paint`, `longtask`) + Resource Timing API + Playwright
`response`-event capture for transferred bytes (Cloudflare strips
`Content-Length` on chunked responses, so the Resource Timing
`transferSize` would otherwise read 0). Script lives at
`/tmp/v15-perf-measure.mjs` (one-shot, not committed — re-run with
`SESSION=<cookie> node ./.v15-perf-measure.mjs > /tmp/v15-perf-results.json`
inside the repo so the script picks up `node_modules/@playwright/test`).
Two viewports per page: **desktop** (`1920×1080`, default Chromium UA) and
**mobile** (Playwright's `Pixel 5` profile).

## Method

For each `(page × viewport)` cell:

1. Open a fresh BrowserContext with Marc's session cookie
   (`healthlog_session=cmox4d6fj…`) injected pre-navigation.
2. Inject a `PerformanceObserver` via `addInitScript` BEFORE navigation so LCP
   and longtask events from the very first paint are captured.
3. `page.goto(url, { waitUntil: "load", timeout: 45_000 })` and then idle for
   3 s so deferred chart code, lazy queries and below-the-fold content settle.
4. Read `performance.getEntriesByType("navigation")[0]`,
   `performance.getEntriesByType("resource")`, plus the longtask / LCP
   captures we accumulated in `window.__perfState`.
5. Total Blocking Time is the longtask-derived proxy:
   `Σ (longtask.duration − 50ms)` over all longtasks ≥ 50 ms.

The "TTI" column in the original brief is omitted because Chromium's
canonical TTI requires a 5 s quiet-window heuristic that isn't worth
synthesising here — `Load` + `TBT` are the actionable signals.

## Per-page metrics

| page                     | viewport | TTFB ms | DCL ms | Load ms |   LCP ms |  TBT ms | Longtasks | Total KiB | JS KiB | CSS KiB |
| ------------------------ | -------- | ------: | -----: | ------: | -------: | ------: | --------: | --------: | -----: | ------: |
| `/`                      | desktop  |     396 |   1080 |    2497 | **2828** | **624** |         1 |       604 |    425 |      16 |
| `/`                      | mobile   |     384 |    752 |    1560 |     2184 |       0 |         0 |       604 |    425 |      16 |
| `/settings/integrations` | desktop  |     500 |    738 |    1498 |     2396 |       0 |         0 |       394 |    297 |      16 |
| `/settings/integrations` | mobile   |     495 |    771 |    1545 |     1900 |       0 |         0 |       386 |    297 |      16 |
| `/admin`                 | desktop  |     584 |    761 |    1611 |     1932 |       0 |         0 |       382 |    291 |      16 |
| `/admin`                 | mobile   |     872 |   1112 |    1920 |     2268 |       0 |         0 |       378 |    291 |      16 |
| `/insights`              | desktop  |     519 |    681 |    1609 |     2264 |      27 |         1 |       608 |    419 |      16 |
| `/insights`              | mobile   |     502 |    667 |    1647 |     2380 |      28 |         1 |       604 |    419 |      16 |

**Read in plain English**: every page comes in well under 2.5 s LCP except
`/` desktop (2.83 s) and `/insights` (~2.3 s). Mobile is faster than desktop
in absolute LCP terms because the Pixel 5 profile uses a smaller viewport
(less LCP candidate area) — the work is the same.

`/` desktop racks up 624 ms TBT from a single longtask: that's the dashboard
hydration cost for the `useQuery` × 9 + `TrendCard` × 8 + `HealthChart`
dynamic-imports firing in parallel.

## Top-5 JS bundles per page

> All sizes are compressed Brotli from CF. The `0vl43uc.17vx1.js` chunk
> appears on every page — that's the framework + Radix + TanStack Query
> bedrock. The `0m4t~kff9equt.js` chunk (52.2 KiB everywhere) is the next.js
> app-router shell + `radix-ui/dialog/dropdown`. The notable per-page chunks
> are flagged with **bold** below.

### `/` (desktop + mobile, identical)

- `0503y5tur7j1f.js` — **108.6 KiB** ← Recharts (loaded via `next/dynamic` from `health-chart` / `mood-chart`, but still on the critical path because the dashboard mounts ≥ 1 chart for any user with measurements)
- `0vl43uc.17vx1.js` — 71.3 KiB ← framework + TanStack Query (every page)
- `0m4t~kff9equt.js` — 52.2 KiB ← Next router shell + Radix overlay primitives
- `0~1ef0ki4ccp~.js` — 36.7 KiB ← shared app code (i18n + auth-shell)
- `0uc70mahb3xof.js` — 15.3 KiB ← `dashboard/page.tsx` per-page chunk

### `/settings/integrations` (desktop + mobile, identical)

- `0vl43uc.17vx1.js` — 71.3 KiB
- `0m4t~kff9equt.js` — 52.2 KiB
- `0~1ef0ki4ccp~.js` — 36.7 KiB
- `01q.1mkz27ebz.js` — 19.8 KiB ← settings/integrations page
- `0d3x9g6k_smzl.js` — 15.0 KiB

### `/admin` (desktop + mobile, identical)

- `0vl43uc.17vx1.js` — 71.3 KiB
- `0m4t~kff9equt.js` — 52.2 KiB
- `0~1ef0ki4ccp~.js` — 36.7 KiB
- `0d3x9g6k_smzl.js` — 15.0 KiB
- `0of675ww0w6~y.js` — 13.6 KiB ← admin status-card-grid

### `/insights` (desktop + mobile, identical)

- `18b.35leqj.iy.js` — **108.5 KiB** ← Recharts, eagerly imported because `insights/page.tsx` uses `ScatterChart`/`Scatter`/`XAxis`/`YAxis`/`CartesianGrid`/`Tooltip`/`ResponsiveContainer` symbols at module top-level (line 42–50)
- `0vl43uc.17vx1.js` — 71.3 KiB
- `0m4t~kff9equt.js` — 52.2 KiB
- `0~1ef0ki4ccp~.js` — 36.7 KiB
- `16c~twjymta_z.js` — 15.6 KiB

## Treemap-flavoured grouping

| group                                        | KiB (uncompressed est ×3 or measured) | notes                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recharts (per page that uses it)             |                              ~108 KiB | by far the heaviest single dep; v1.5 candidate for replacement. v1.4.6 already moved `HealthChart`/`MoodChart` to `next/dynamic`, but `/insights` still imports the Scatter primitives eagerly. |
| Framework (Next.js + React + TanStack Query) |                               ~71 KiB | unavoidable baseline                                                                                                                                                                            |
| Radix primitives + app-router shell          |                               ~52 KiB | unavoidable baseline                                                                                                                                                                            |
| Shared app code (i18n, auth-shell, layout)   |                               ~37 KiB | unavoidable baseline                                                                                                                                                                            |
| Per-page app code                            |                             13–20 KiB | within budget                                                                                                                                                                                   |

Pages without charts (`/admin`, `/settings/integrations`) are about 132 KiB
lighter than the chart pages, confirming Recharts is the dominant
single-dependency cost.

## Slowest API calls observed

Measured for `/` desktop (worst case). Numbers are the per-request
`PerformanceResourceTiming.duration` (queue + DNS + connect + TTFB + body):

| endpoint                                           |  ms |
| -------------------------------------------------- | --: |
| `/api/measurements?type=WEIGHT&limit=500&offset=0` | 812 |
| `/api/notifications/preferences`                   | 654 |
| `/api/gamification/achievements`                   | 651 |
| `/api/measurements?type=PULSE`                     | 506 |
| `/api/measurements?type=BLOOD_PRESSURE_SYS`        | 404 |
| `/api/measurements?type=BLOOD_PRESSURE_DIA`        | 399 |
| `/api/mood/analytics`                              | 351 |
| `/api/analytics`                                   | 342 |
| `/api/medications`                                 | 340 |
| `/api/withings/status`                             | 303 |

Two surprises:

- `notifications/preferences` and `withings/status` are fired by the
  `GettingStartedChecklist` even when the user is well past onboarding
  (Marc has `onboardingCompletedAt = 2026-02-20` and 1000+ measurements).
  The checklist short-circuits with `null` after fetching, so the network
  is wasted.
- `gamification/achievements` is hot-polled every 2 minutes by
  `AchievementUnlockNotifier`. Acceptable cadence; not on the win list.

## Top 3 wins

### 1. Defer Recharts imports on `/insights` (S, **implemented**)

- **File**: `src/app/insights/page.tsx`
- **What**: Replace the eager `import { ScatterChart, … } from "recharts"`
  with per-symbol `next/dynamic` imports (`ssr: false`). Each scatter card
  is below the fold — it sits inside the correlation cards that gate on
  `data.bpMedicationScatterData.length >= 5` etc.
- **Expected impact**: Moves the 108.5 KiB Recharts chunk off the initial
  bundle. LCP-critical content no longer waits for Recharts to parse on
  the main thread. Same Recharts that the dashboard already pays for is
  shared at runtime, so no double-fetch on cache-warm navigation.
- **Effort**: ~10 LOC (the seven recharts symbols become seven
  `dynamic(...)` consts).
- **Risk**: each first paint of a scatter section will Suspense-fallback
  for ~1 frame while the chunk downloads. That matches the existing
  `<HealthChart>` UX on the same page.

### 2. Skip `GettingStartedChecklist` data fetches for post-onboarding users (S, **implemented**)

- **File**: `src/components/onboarding/getting-started-checklist.tsx`
- **What**: Gate `withings/status` and `notifications/preferences` on
  `!!user && user.onboardingCompletedAt == null`. The two queries fire
  unconditionally today, then the checklist self-hides because the user
  has already completed onboarding.
- **Expected impact**: 2 fewer API calls per dashboard load for every
  established user. Saves ~950 ms of network on `/` desktop.
- **Effort**: 2 LOC (one extra clause in each `enabled:` field).
- **Risk**: the corner case of a returning user with
  `onboardingCompletedAt != null` but `< 5` measurements (e.g. they
  deleted readings post-onboarding) will see a checklist with stale
  `withingsConnected` / `notificationsConfigured` flags. Acceptable —
  the checklist already gracefully renders unknown defaults.

### 3. Replace Recharts on the dashboard (L, **deferred to v1.5.1**)

- **What**: Drop Recharts in favour of a smaller library (Visx, Chart.js
  4, or hand-rolled SVG). Recharts is ~108 KiB Brotli for a use case that
  needs ~3 chart variants (line, area, scatter).
- **Expected impact**: −80 to −100 KiB initial JS on `/` and `/insights`;
  TBT win on `/` desktop because Recharts hydration is the dominant
  longtask source.
- **Effort**: L. New dep + every chart in `src/components/charts/` needs
  rewrite. Out of scope for v1.5.0 — track in v1.5.1 backlog.
- **Why deferred**: hard rule "no new dependencies in v1.5".

### Bonus / honourable mentions

- `Achievements` polling cadence on the dashboard is 2 min, staleTime 60 s.
  Reasonable, no win.
- `staleTime: 5 * 60 * 1000` is already the global default in
  `providers.tsx` — no global tuning needed.
- Image lazy-load: only the `<AvatarImage>` in `sidebar-nav.tsx` and one
  `<img>` in `admin/feedback-inbox-section.tsx` exist. The avatar is
  in-viewport; the feedback `<img>` is admin (Phase 4b territory). Skip.

## Verification

Local `pnpm build` cannot complete on this machine due to a Node-25
upstream regression (`Cannot read private member #state from an object
whose class did not declare it` in turbopack's prerender path; this is
the same bug noted in `CLAUDE.md`'s pnpm-build entry). Wins #1 and #2
therefore can't be re-measured against prod until v1.5.0 ships and
Coolify force-pulls the new bundle. Both wins are nevertheless verified
by static code review:

- **Win #1 — defer Recharts**: every changed import follows the exact
  same `next/dynamic(... ssr: false)` shape that
  `src/app/insights/page.tsx` already uses for `HealthChart` and
  `MoodChart`. Next 16 / Turbopack splits each `dynamic(...)` callsite
  into its own async chunk. Recharts internally re-uses one shared
  module so the seven dynamic imports collapse to a single chunk request
  at runtime, identical to the existing dashboard behaviour.
- **Win #2 — skip checklist fetches**: `onboardingPending` is read once
  per render from `user.onboardingCompletedAt`. When false, both
  `useQuery({ enabled: onboardingPending })` calls stay idle. The
  downstream `shouldShowChecklist()` already hides the component for
  every post-onboarding user with ≥ 5 measurements, so no UI regresses.
  `pnpm test` (95 files / 733 tests) is green after the change.

A re-measure after v1.5.0 ships should show:

- `/insights` initial JS dropping from ~419 KiB to ~310 KiB (the 108 KiB
  Recharts chunk moves out of the critical path and is only fetched if a
  scatter section actually mounts).
- `/` dashboard total request count dropping from 9 to 7 for any user
  with `onboardingCompletedAt != null`, eliminating the
  `notifications/preferences` (~654 ms) and `withings/status` (~303 ms)
  calls.

If post-deploy measurement contradicts either expectation, revert the
relevant commit and update this document.
