# Phase A1 — BD-Zielbereich tile 7T / 30T sub-values

Marathon: v1.4.18 Wave-A bucket A1 (parallel with A2 api-tokens, A3
chart revert, B1 achievements)
Started: 2026-05-09T~10:08+02:00
Finished: 2026-05-09T~10:15+02:00

## Symptom
Marc reported the dashboard "BD im Zielbereich" tile rendered the
30-day headline correctly (**50,0 %**, the v1.4.16 A2 ceiling-semantics
fix) but the row underneath the headline still showed **`7T: —`** and
**`30T: —`** even though Marc clearly has paired BP readings in both
windows.

## Root cause
`/api/analytics` (`src/app/api/analytics/route.ts`) only computed and
returned a single `bpInTargetPct` field — the share over the trailing
30 days. The dashboard tile (`src/app/page.tsx`) explicitly passed
`avg7={null}` and `avg30={null}` to the `TrendCard` component, which
correctly renders "—" as the friendly fallback when those fields are
null. So the sub-values were never wired to data, regardless of how
many readings the user had — pure unfinished feature, not a calculation
bug.

Confirmed against Marc's prod data on apps-01: user
`cmlupy4tn000001rpzx1pxvz7` has 2 paired sys+dia in last 7 days and
10 in last 30 days. Both windows have data; nothing should render "—".

## Fix
Added `computeBpInTargetWindows()` next to the existing
`computeBpInTargetPct()` helper in
`src/lib/analytics/bp-in-target.ts`. Same predicate +
`isBpReadingInTarget()` ceiling semantics from v1.4.16; the new
function filters the input series by `measuredAt >= now − Nd` and
delegates to `computeBpInTargetPct()` for each window. Returns
`{ last7Days, last30Days }`, both nullable so the tile renders "—" only
when a window genuinely has no paired readings.

Wired into the analytics route — fetched 30-day data once, derived
both shares, and added `bpInTargetPct7d` / `bpInTargetPct30d` to the
response. Wired into the dashboard tile —
`avg7={data?.bpInTargetPct7d}`, `avg30={data?.bpInTargetPct30d}`.
Headline (`bpInTargetPct`) preserved for cached client bundles +
matches `last30Days` so a v1.4.17 PWA displays the same number.

## Tests (TDD)
1. **Unit** (`src/lib/analytics/__tests__/bp-in-target.test.ts`) —
   6 new cases for `computeBpInTargetWindows`: empty input,
   mixed-window data, null-7d-with-real-30d, default-clock smoke,
   Marc's production fixture. Failed first (`is not a function`),
   went green after the helper landed.
2. **Integration** (`tests/integration/bp-in-target.test.ts`) — 2 new
   testcontainer cases: seed 30 days of BP at fractional-day offsets
   (avoids the boundary flakiness of integer-day seeds) and assert
   both windows produce non-null hand-counted shares; second case
   verifies a user with only 14-day-old data sees `7T = null,
   30T = real`.

## Verification
- `pnpm test`: **1559 / 1559** green (was 1547; 8 new cases added)
- `pnpm test:integration`: **61 / 61** green (was 59; 2 new cases)
- `pnpm typecheck`: clean
- `pnpm lint`: 12 baseline warnings, **0 new**

## Commit
`23363ca` —
`fix(dashboard): wire 7T and 30T sub-values on the BD-Zielbereich tile`

Pushed to origin/main on first attempt (no rebase race against the
other Wave-A agents).
