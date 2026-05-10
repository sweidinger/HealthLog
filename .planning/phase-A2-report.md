# Phase A2 — Charts mobile audit (header overflow + x-axis density)

Marathon: v1.4.19 Wave-A
Agent: A2 (parallel with A1, A3, A4, A5, A6, A7, A8)
Commits: `77a3ad3` (fix), `a739085` (test) on origin/main

## Scope

Marc reported on his Pixel 5 that the chart cards on `/dashboard` and
`/insights` looked broken in two distinct ways:

1. The "Wochendurchschnitt" / "Weekly avg" bucket-aggregation chip
   plus the optional comparison-period chip plus the four range tabs
   (`7 Pkt / 30 Pkt / 90 Pkt / Alle`) plus the new cog dropdown all
   sat on a single `flex justify-between` row. On Pixel 5 the chips
   ate enough horizontal space that the four tabs wrapped to a 2nd
   row inside the same flex container; on Galaxy Fold compact (280
   px) the tabs split across three or four rows and the medication
   card overflowed horizontally.

2. The medication compliance chart drew one tick per data point on
   the x-axis. A 30-day Pixel-5 window painted thirty overlapping
   labels into a 393 px gutter, while the weight / BMI charts looked
   sparser by accident — they auto-bucketed daily → weekly above 90
   days but at the 30-day range still drew a tick every couple of
   days. The chart row read inconsistently across metrics.

## Method

Playwright headless against live PROD with Marc's session cookie at
four mobile viewports: Pixel 5 (393 × 851), iPhone 12 (390 × 844),
iPhone SE (375 × 667), Galaxy Fold compact (280 × 653). For each
chart card on `/` and `/insights` the probe captured: header
height, number of distinct y-rows the range tabs occupied,
horizontal overflow, x-axis visible-tick count.

The probe script lives at `.planning/v1419-a2-prod-probe.mjs`;
machine-readable findings + per-viewport screenshots in
`/tmp/v1419-a2-prod/` (kept out of git because they're 1-2 MB of
PNGs); narrative summary at `.planning/phase-A2-mobile-findings.md`.

## Fix shipped — `77a3ad3`

The header is now stacked into two rows below the sm breakpoint:
title + chips on row 1; range tabs + cog right-aligned on row 2 with
`flex-nowrap` so tabs always fit a single row at 280 px. Tab padding
shrinks to `px-2` on mobile, `px-3` ≥ sm. The decorative
bucket-aggregation chip + comparison-caption / unavailable chips all
become `hidden sm:inline-flex` — the range tabs already communicate
the visible window and the cog dropdown surfaces the overlay state
explicitly.

Applied to `HealthChart` (BP / weight / pulse / BMI / sleep / steps),
`MoodChart` and `MedicationComplianceChart` consistently. Above sm
the original side-by-side layout is preserved with all chips visible.

A new helper at `src/lib/charts/x-axis-density.ts` maps viewport
width to a maximum tick count and computes the corresponding Recharts
`interval` skip count: ≤ 360 px → 4 ticks, ≤ 480 px → 6 ticks, ≤ 768
px → 8 ticks, > 768 px → 10 ticks. A reactive `useViewportWidth`
hook in `src/hooks/` reads the layout viewport and updates on resize
/ orientation-change with a desktop default during SSR.

Wired into `HealthChart`, `MoodChart`, `MedicationComplianceChart`,
`ComplianceLineChart`. The `ScatterCorrelationChart` was deliberately
left alone — its x-axis is numeric (BP / weight values, not a time
series) and it already supplies an explicit `ticks` array.

## Test deltas — `a739085`

- 13 helper unit tests at `src/lib/charts/__tests__/x-axis-density.test.ts`:
  bucket math for Fold / Pixel 5 / tablet / desktop widths over 7 /
  30 / 90 / 365-point ranges plus invalid-input fallbacks.
- New e2e spec at `e2e/charts-mobile.spec.ts` running only on the
  `chromium-mobile` project (Pixel 5). Two assertions:
  one tab row per chart card, ≤ 7 visible x-axis ticks. Mock data
  feeds 30 days of measurements + 30 days of compliance points so
  the chart wrappers actually paint.

## Verification

- `pnpm test`: 1637 / 1637 green.
- `pnpm typecheck`: A2 surface clean (one A3-owned error in
  `src/app/insights/page.tsx` is unrelated).
- `pnpm lint`: 0 errors / 17 warnings (12 baseline + 5 from
  concurrent A3 commits, none from A2).

## Constraints honoured

Touched only the assigned A2 surface — chart wrappers + new helper /
hook + new tests. Did not touch `src/lib/insights/*`,
`src/components/insights/*`, `src/lib/ai/prompts/*`,
`src/components/settings/*`, `src/components/admin/*`. No new
dependencies. Pre-commit hooks pass on every commit (no `--no-verify`,
no `--no-gpg-sign`).

## Note on the parallel-agent race

The first attempt at the second commit picked up a different agent's
`phase-A5-report.md` because their `git add` and my `git add`
overlapped. The polluted commit `0cf23f3` shipped to origin before
my local rebase-drop could land. The cleanup re-committed my actual
files as `a739085` immediately after; final origin/main carries both
commits but only `a739085` corresponds to the message. Non-destructive
— A5's report stayed in history under the wrong commit message,
my own files reached origin under the right one. Documented in the
v1.4.19 backlog so the next planner can clean up if needed.
