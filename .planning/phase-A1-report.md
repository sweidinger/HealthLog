# Phase A1 — BD-Zielbereich constant 50% (4th attempt)

Marathon: v1.4.19 Wave-A bucket A1
Started: 2026-05-10T12:55+02:00
Finished: 2026-05-10T13:05+02:00

## Symptom

Marc reported the dashboard BD-Zielbereich tile pinned at **EXACTLY 50 %
on 7T, 30T, AND the headline (total)** for his real production data —
the fourth attempt at this surface (v1.4.15 → v1.4.16 → v1.4.18 →
v1.4.19). The earlier passes legitimately landed: v1.4.15 fixed the
denominator (paired readings, not `sysData.length`), v1.4.16 fixed the
predicate (one-sided ceiling with hypotension floor instead of narrow
band), v1.4.18 wired the `avg7` / `avg30` sub-values from a windowed
helper. None of those addressed why the headline kept matching `30T`.

## Live-DB audit (Marc's prod data on `apps-01`)

Container `db-pg8wggwogo8c4gc4ks0kk4ss-105148113251`, user
`cmlupy4tn000001rpzx1pxvz7`, DOB 1985-07-09 → under-65 target band
(sysHigh 129 / diaHigh 79 + clinical floor 90/50).

Closest-pair SQL aggregate over the canonical predicate:

| Scope    | Pairs | In target | %      |
| -------- | ----- | --------- | ------ |
| 7d       | 2     | 1         | 50.0 % |
| 30d      | 10    | 5         | 50.0 % |
| All time | 572   | 62        | 10.8 % |

The two recent 50 %s are a **real coincidence** (Marc's recent BP control
genuinely sits half above the diastolic ceiling). The headline cannot
legitimately be 50 % — it must be ~11 %.

## Root cause

`src/app/api/analytics/route.ts` set
`bpInTargetPct = windows.last30Days?.pct`. The headline was a **literal
copy of the `30T` sub-value** — `bpInTargetPct === bpInTargetPct30d` by
construction. `computeBpInTargetWindows` only returned 7d + 30d windows,
so even with a different routing the headline could never differ from
one of the sub-values.

The brief's hypothesis-1 was inverted in direction but otherwise
correct: not the 7T/30T branches reusing the all-time, but the
all-time headline reusing the 30-day. Hypothesis-2/3/4/5 (filter
no-op, rendering snap, boundary aliasing, cache hit) all ruled out
by the live-DB SQL aggregate.

## Fix

1. `computeBpInTargetWindows` now returns a third `allTime` window
   computed against the entire input series (no time filter).
2. Analytics route fetches all paired BP rows (drops the 30-day
   `gte` filter) and routes the headline through `windows.allTime?.pct`.
   Re-pairs once per request (`computeBpInTargetPct` runs three times
   internally with progressively smaller filtered slices, but reads
   the same input arrays).
3. 7T / 30T sub-values unchanged — same windowed slices as v1.4.18.

## Tests (TDD red→green)

- **Unit** (`src/lib/analytics/__tests__/bp-in-target.test.ts`): 3 new
  `computeBpInTargetWindows` cases for the all-time contract — diverging
  recent vs older mix, empty-input null guard, Marc's 30-day fixture
  re-asserted (10 pairs only, so allTime == 30d == 50 % is the legitimate
  coincidence; the smoking-gun test layers older-history pairs to force
  divergence). Failed first (`undefined` for `result.allTime`); turned
  green after the helper landed.
- **Integration** (`tests/integration/bp-in-target.test.ts`): 1 new
  testcontainer case seeds 40 paired readings (2 in last 7d, 10 in last
  30d, 30 older, all-out-of-target older) against real Postgres and
  asserts the three numbers (50 % / 50 % / 13 %) are independent.
- Full suite: 1640 / 1645 unit (5 failing pre-existed in A3's
  `insights-polish.test.ts` — verified by stash-and-rerun before any
  edits), 67 / 67 integration, typecheck clean, lint 12 baseline 0 new.

## Verification against Marc's expected values (post-deploy)

Pre-fix tile: **50 % / 7T 50 / 30T 50** (headline=30d=50)
Post-fix tile: **11 % / 7T 50 / 30T 50** (headline=allTime ≈ 10.8 → 11)

Once deployed, the three numbers will diverge naturally for any user
whose older history shape differs from their recent 30-day window —
Marc included.

## Commit

`a856272` —
`fix(dashboard): BD-Zielbereich headline shows all-time, not 30-day`

Pushed to origin/main first attempt (no rebase race; A5's
`ba0d6b8` already on main, mine layered cleanly on top).
