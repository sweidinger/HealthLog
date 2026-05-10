# Phase B8 — Extended comparison views (Vormonat / Vorjahr)

Status: complete (must-ship pieces); dedicated `/insights/compare` page + UI hero callout deferred to v1.4.17 with a planning note.
Date: 2026-05-10T~02:38+02:00
Branch: origin/main (fast-forwarded from `agent/b8-comparison-views`).

## What landed

Four atomic TDD-first commits on origin/main (`43204cb..f9f99ea`):

1. `775df8c feat(comparison): comparison toggle persists baseline preference`
2. `2cf7b74 feat(charts): comparison overlay shows prior-period as dimmed line with delta tooltip`
3. `e4a408e feat(dashboard): tiles show comparison delta callout when toggle is active`
4. `f9f99ea feat(insights): AI narrates comparison when toggle is active`

### 1. Toggle + persistence

The "Compare to" Select pulldown lives at the top of `Settings → Dashboard`
(`src/components/settings/dashboard-layout-section.tsx`), driven by
`COMPARISON_BASELINES = ["none", "lastMonth", "lastYear"]`. The
preference rides on the existing `User.dashboardWidgetsJson` blob
per research §7 Q3 — no Prisma migration. The resolver clamps unknown
values back to `"none"` and defaults to `"none"` for legacy layouts.
The PUT schema accepts the new optional field; pre-B8 clients keep
PUTing without it. 4 new unit tests in `dashboard-layout.test.ts`.

### 2. Chart overlay

HealthChart and MoodChart accept a `compareBaseline` prop. When set,
a parallel daily series is computed via `shiftDailySeriesForward()`
(new pure helper at `src/lib/charts/comparison-shift.ts`, 11 unit
tests) and merged onto the visible chart-data under `${type}_compare`
keys. Each type renders a dimmed dashed `<Line>` (45% opacity, 1.25px
stroke, `4 3` dasharray, same Dracula token as the current line) so
the user reads the current line first and the overlay as orientation.
The chart header gains a `vs. last month` / `vs. last year` caption
or a muted "Comparison unavailable — no data from last month yet"
fallback when the prior period has no overlap. The tooltip switches
its delta from "vs. your normal" to "vs. last month / last year" and
adds a second row with the prior absolute value. 2 SSR tests in
`health-chart-comparison.test.tsx`.

### 3. Tile delta callout

DataSummary gains `avg30LastMonth` / `avg30LastYear` (30-day means
over `[30, 60)` and `[365, 395)` day windows). Every metric the
analytics API summarises gets these for free — no extra DB queries.
TrendCard accepts `compareBaseline` + `compareDelta`; when both are
set the tile renders "Δ −2.3 kg vs. last month" on a second line
below the latest value, colour-coded via the existing
`directionSentiment` rules. Mobile-friendly: stays on its own line,
no horizontal scroll. 6 SSR tests in `trend-card-comparison.test.tsx`.

### 4. AI narrative

`buildUserPrompt()` accepts an optional `ComparisonSnapshot`. When
supplied it appends a SYSTEM CONTEXT block listing each metric's
current 30d avg, baseline 30d avg, absolute delta, and percentage
delta. The strict system prompt gains a 6th ground rule: narrate the
most clinically-significant non-null delta in the summary's first
sentence; do NOT invent comparison numbers. PROMPT_VERSION bumped
`4.16.0 → 4.16.1`. The route layer at
`/api/insights/generate/route.ts` reads
`User.dashboardWidgetsJson.comparisonBaseline` and runs `summarize()`
once per measurement type so the prior-period numbers the LLM sees
match exactly what the tiles render. 8 new unit tests in
`prompt-comparison.test.ts`.

## Acceptance-criteria coverage

| #   | Criterion                          | Status                                                                                    |
| --- | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | Toggle + persistence               | shipped (commit 1)                                                                        |
| 2   | Chart overlay rendering            | shipped (commit 2)                                                                        |
| 3   | Tile delta callout                 | shipped (commit 3)                                                                        |
| 4   | Insights narrative integration     | shipped — prompt block + ground rule (commit 4)                                           |
| 5   | Dedicated `/insights/compare` page | DEFERRED to v1.4.17                                                                       |
| 6   | i18n EN+DE                         | shipped — 14 new key paths under `comparison.*`                                           |
| 7   | Tests                              | shipped — 27 new tests (4 layout + 11 shift helper + 2 chart SSR + 6 tile SSR + 8 prompt) |

## What's deferred to v1.4.17

- **`/insights/compare` page (research-recommended bonus)** — the
  brief flagged it as optional; the toggle + chart overlay + tile
  callout already deliver the full comparison story across the
  existing dashboard + insights surfaces. A dedicated page would be
  a side-by-side Recharts of current vs. prior with sticky toggle;
  good v1.4.17 polish but not load-bearing.
- **Schema + UI hero callout for the AI's comparison block** — the
  prompt now narrates comparison correctly (delta sentences appear
  in the summary), but the `aiInsightResponseSchema.comparison`
  optional field was NOT added so the UI can't render a separate
  hero block for "Tracking against last month — your avg systolic
  improved by 4 mmHg". The narration lands inside the existing
  summary, which is the cheap path. v1.4.17 can extend the schema +
  add an `<InsightsComparisonCallout>` component above the
  recommendations grid.
- **Insights page comparison callout component** — `comparison.insightsCallout.{lastMonth,lastYear}` keys are reserved in i18n EN+DE so the v1.4.17 component drops in clean.

## Verification

- `pnpm test` — 1532/1532 (was 1518 → +14 net for B8 across the suite delta, accounting for trend-card snapshot drift)
- `pnpm test:integration` — 59/59
- `pnpm typecheck` — 0 errors
- `pnpm lint` — 12 pre-existing warnings / 0 errors

## Architectural decisions worth surfacing

- **JSON pivot vs. dedicated column** for `comparisonBaseline`: per research §7 Q3 the field is ephemeral (a UI affordance, not an analytical attribute) so a dedicated `User.compareBaselinePref` column is over-engineering. The blob path keeps the v1.4.16 release migration-free; if admin SQL-greppability becomes important in v1.5+, the schema can be promoted then.
- **Forward shift vs. backward shift**: `shiftDailySeriesForward(rows, "lastMonth")` adds 30 days to each prior row's timestamp so the prior point lines up with its current-period sibling on the visible x-axis. The alternative ("subtract 30 days from the current") makes the user squint at a different x-position; forward-shift is the convention every comparison-overlay visualisation uses (Apple Health, Oura).
- **Day-exact integer shift**: the chart's daily bucket keys live at UTC noon of each Berlin calendar day, so `+30 * MS_PER_DAY` does NOT cross a DST boundary. This is the simpler and provably-correct path; calendar-month arithmetic would surface edge cases (Jan 31 → Feb 28 vs. Mar 3) we don't need.
- **Single source of truth for the delta**: the analytics API's `summarize()` helper now emits `avg30LastMonth` + `avg30LastYear`, the dashboard's `tileCompareDelta()` uses them, and the AI route's snapshot builder uses them — all three surfaces narrate the same number. A user comparing the chart, the tile, and the AI summary sees the same delta everywhere.
- **Default-on AI narrative when toggle is on (research §7 Q4)**: a secondary "include comparison in AI" preference would surprise users — they flipped the toggle for a reason. Cheap LLM-token cost (the SYSTEM CONTEXT block is < 200 tokens) is worth the consistency.

## Cross-feature notes

- **B5d confidence interaction**: the deterministic confidence resolver in `generateInsight()` currently has no comparison input, so a "your BP improved by 4 mmHg vs. last month" narration is rated by the v1.4.16 confidence formula on `(n, recencyDays, deviationStdRatio)` derived from the metricSource alone. v1.4.17 can extend `ConfidenceInputs` with a `comparisonDelta` field if Marc wants improving-trend recs to score higher than warning-trend recs of the same magnitude.
- **B5e feedback aggregator**: feedback rows attribute the prompt version (`promptVersion` column on `RecommendationFeedback`), so the v1.4.17 ratchet has separate buckets for `4.16.0` (B5a/c/d) vs. `4.16.1` (B8) responses. This lets the aggregator detect whether the comparison narration improves or hurts helpful-rate.

## Hand-off

`/insights/compare` route + schema flip + UI hero callout left as v1.4.17 follow-up. The toggle + chart-overlay + tile-callout + AI narration already cover the brief's must-ship scope.
