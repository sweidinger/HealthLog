# Phase A2 — Mobile chart findings (PROD audit + post-fix verification)

Marathon: v1.4.19 Wave-A
Agent: A2 (parallel with A1, A3, A4, A5, A6, A7, A8)
Probe script: `.planning/v1419-a2-prod-probe.mjs`
Probe output (JSON + screenshots): `/tmp/v1419-a2-prod/`

## Method

Playwright headless against `https://healthlog.bombeck.io` with Marc's
session cookie, four mobile viewports:

- Pixel 5 — 393 × 851
- iPhone 12 — 390 × 844
- iPhone SE — 375 × 667
- Galaxy Fold compact — 280 × 653

For each chart card on `/` (dashboard) and `/insights`:

- Header height (px from top of card to bottom of controls row)
- Number of distinct vertical rows the range tabs occupy
  (`new Set(tabRects.map(t => Math.round(t.top))).size`)
- `card.scrollWidth > card.clientWidth` (horizontal overflow)
- `XAxis` tick count visible inside the SVG

## Pre-fix readings (live PROD before A2 ship)

```
viewport      page       chart                    tabs  rows  header  overflow
pixel5        insights   Blood Pressure           4     2     92      false
pixel5        insights   Pulse                    4     2     92      false
iphone12      dashboard  Blood Pressure           4     2     92      false
iphone12      dashboard  Pulse                    4     2     92      false
iphone12      dashboard  Mood                     4     1     108     false
iphone12      dashboard  Medications              3     2     92      false
fold-compact  dashboard  Blood Pressure           4     4     188     false
fold-compact  dashboard  Pulse                    4     3     188     false
fold-compact  dashboard  Mood                     4     2     108     false
fold-compact  dashboard  Medications              3     3     188     true ←
```

(Charts with header == 44 px and rows == 1 — Weight, BMI — already
fitted because they had no bucket-aggregation chip and no comparison
caption to push the tabs around. The bug was specific to charts whose
title row carried extra chips.)

Two distinct symptoms confirmed:

**1. Header label-band overflow.** Marc's complaint about
"Wochendurchschnitt + 7T/30T/90T/Alle wraps and breaks the layout" was
exactly this: the bucket-aggregation chip ("Weekly avg" / "Monthly
avg") + the optional comparison-caption chip + 4 range tabs + the cog
dropdown all sat on one `flex justify-between` row. On Pixel 5 / iPhone
12 the chips ate enough horizontal space that the 4 tabs wrapped to a
2nd row inside the same flex container — header height jumped 44 → 92.
On Galaxy Fold compact (280 px) the tabs split into 3-4 rows and one
chart overflowed horizontally.

**2. X-axis tick density inconsistent.** Medication chart used the
default Recharts tick rendering with `interval="preserveStartEnd"` —
that's _one tick per data point_, so a 30-day Pixel 5 window painted 30
overlapping date labels. Weight / BMI / pulse / mood charts didn't show
the same density because they auto-bucketed daily → weekly above 90
days, but at the 30-day range they still drew a tick every couple of
days.

## Fixes shipped

**Fix 1 — header layout** (commit `fix(charts): mobile header layout + unified x-axis tick density`):

- `<sm`: stack the header into two rows. Title + chips on row 1; range
  tabs + cog right-aligned on row 2. Tabs use `flex-nowrap` and
  `px-2 sm:px-3` so they always fit a single row at 280 px.
- Bucket-aggregation chip + comparison caption + comparison-unavailable
  fallback all `hidden sm:inline-flex` — they're decorative and the
  range tabs already communicate the visible window. The cog dropdown
  surfaces overlays explicitly.
- `≥sm`: original side-by-side layout, all chips visible.
- Applied to HealthChart (BP / weight / pulse / BMI / sleep / steps),
  MoodChart, MedicationComplianceChart consistently.

**Fix 2 — universal X-axis tick-density helper** (same commit):

- New `src/lib/charts/x-axis-density.ts` with `chooseTickInterval(N, w)`:
  - 280 px (Fold) → max 4 ticks
  - 393 px (Pixel 5) / 390 px (iPhone 12) → max 6 ticks
  - 481-768 px (small tablet) → max 8 ticks
  - > 768 px (desktop) → max 10 ticks
- New `src/hooks/use-viewport-width.ts` for SSR-safe reactive viewport
  width with desktop default during SSR.
- Wired into all 4 chart wrappers (HealthChart, MoodChart,
  MedicationComplianceChart, ComplianceLineChart). The
  ScatterCorrelationChart was deliberately left alone — its X-axis is
  numeric (BP / weight values), not a time series, and already supplies
  explicit `ticks={...}` arrays.

## Post-fix gating

The two regressions are gated by an e2e spec at
`e2e/charts-mobile.spec.ts` that runs only on the `chromium-mobile`
project (Pixel 5 profile). Two assertions per chart:

- All `[data-slot=chart-range-tab]` inside a card share one rounded
  `top` coordinate — i.e. one horizontal row.
- Each `recharts-xAxis` paints ≤ 7 visible tick labels.

Helper unit tests at `src/lib/charts/__tests__/x-axis-density.test.ts`
pin the interval math for Fold / Pixel 5 / tablet / desktop widths
across 7 / 30 / 90 / 365-point ranges.

## Constraints honoured

Touched only the assigned A2 surface (chart wrappers + new
helper/hook). Did not touch `src/lib/insights/*`, `src/components/insights/*`,
`src/lib/ai/prompts/*`, `src/components/settings/*`, or
`src/components/admin/*`. No new dependencies. Pre-commit hooks pass
on every commit.

## Note on parallel-agent race

During the second commit a parallel agent staged + committed against
the same index, the first attempt at commit 2 picked up their
`phase-A5-report.md` instead of my files (the staged set got swapped
between my `git add` and `git commit`). The polluted commit was
dropped via `git rebase --onto` before push; the parallel agent's work
was preserved by cherry-picking their amended commit forward. The
final history is clean and ordered by commit time.
