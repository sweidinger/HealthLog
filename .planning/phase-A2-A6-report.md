# Phase A2 + A6 — BD-Zielbereich real-fix + medication-chart parity

Marathon: v1.4.16 Wave-A bucket-2
Agent: A2+A6 (parallel with A1+A3, A4+A5+A8b, A7)
Started: 2026-05-09T23:25+02:00
Finished: 2026-05-09T23:35+02:00

## A2 — BD-Zielbereich root-cause analysis

### Symptom
Marc reported the dashboard tile rendered **0 %** despite multiple BP
readings clearly inside the well-controlled range. v1.4.15 phase-A4
report claimed this was fixed (commit `a967895`); it was not.

### Investigation
1. Read `src/lib/analytics/bp-in-target.ts` (the v1.4.15 fix). It
   correctly fixed the *denominator* (paired-readings instead of
   `sysData.length`) and added a same-Berlin-day fallback for imports
   rounded past the 5-minute pairing window.
2. Read the v1.4.15 phase-A4 report — claim was specifically the
   denominator fix. The "in target" *predicate itself* was untouched:
   `sys >= sysLow && sys <= sysHigh && dia >= diaLow && dia <= diaHigh`.
3. Pulled Marc's actual BP measurements from production (apps-01, container
   `db-pg8wggwogo8c4gc4ks0kk4ss-212006924671`, user
   `cmlupy4tn000001rpzx1pxvz7`, DOB 1985-07-09 → under-65 target band
   Sys 120-129 / Dia 70-79). Last 30 days = 10 paired readings.
4. Hand-counted "in target" under v1.4.15 narrow-band semantics:
   - 117/79 → sys 117 < 120 → OUT
   - 122/86 → dia 86 > 79 → OUT
   - 108/76 → sys 108 < 120 → OUT
   - 106/73 → sys 106 < 120 → OUT
   - 127/86 → dia 86 > 79 → OUT
   - 115/78 → sys 115 < 120 → OUT
   - 108/75 → sys 108 < 120 → OUT
   - 124/82 → dia 82 > 79 → OUT
   - 126/80 → dia 80 > 79 → OUT
   - 133/95 → both out → OUT
   → **0 / 10 = 0 %**. Calculation is reproducing exactly what Marc
   sees. **No bug in the v1.4.15 code; the bug is in the semantic.**

### Root cause
The "in-target" predicate uses the **ESH 2023 narrow goal band** (the
treatment goal for hypertensive patients on therapy: keep BP between
sysLow and sysHigh, not below sysLow because sub-band can indicate
treatment-induced hypotension on this particular subgroup). HealthLog's
user is the general population. Marc's reading 117/79 is textbook
normotensive — well-controlled, below the ceiling, above hypotension —
which everyone considers in target, including clinical practice ("BP is
well-controlled"). The narrow band counts him out for being healthier
than the goal.

This is **hypothesis #2** from the brief (Wrong target range), with the
twist that the issue is the *lower bound being too high*, not the
upper bound being too low.

### Fix
Centralised the predicate in a new exported `isBpReadingInTarget()`
helper (`src/lib/analytics/bp-in-target.ts`) with one-sided ceiling
semantics + clinical hypotension floors:

```
in-target := sys >= 90 AND sys <= sysHigh
           AND dia >= 50 AND dia <= diaHigh
```

The 90/50 floors guard against silently counting symptomatic
hypotension as "good control". Updated all 6 historical inline copies
of the narrow-band check (analytics route uses the helper directly;
blood-pressure-status, features, general-status, insights/cards,
insights/comprehensive, insights/targets all now call
`isBpReadingInTarget()` instead of repeating the inline formula). This
also closes a maintenance trap — pre-fix any future ESH update would
need to land in 5 inline locations.

### Tests (TDD-style)
- `src/lib/analytics/__tests__/bp-in-target.test.ts` — 6 new
  `isBpReadingInTarget()` cases + a regression test that **re-uses
  Marc's exact production fixture** (10 paired readings → 50 % under
  v1.4.16 ceiling semantics, would have been 0 % under v1.4.15
  narrow-band). NaN-tolerance test added for null-handling defence.
- `tests/integration/bp-in-target.test.ts` (NEW) — Postgres
  testcontainer suite: seeds Marc's fixture against the real Prisma
  client and asserts the helper produces 50 %; covers empty / sys-only
  / hypotension-floor edge cases.

### Cache invalidation
Verified `measurementDependentKeys` already includes
`queryKeys.analytics()` so adding a BP measurement invalidates the
tile's TanStack Query cache (per file `src/lib/query-keys.ts`). The
0 % bug was purely calculation, not staleness.

### Commit
`577d8dd` — `fix(insights): BD-Zielbereich computes correctly for real measurement data`

## A6 — Medication-chart 7d-trend + target-range

### Changes
`src/components/charts/medication-compliance-chart.tsx`:
- New `computeMedicationTrend7d()` exported helper. Mean of recent-7
  daily rates − mean of prior-7, capped at 14-day window.
  Mean-difference rather than slope so a single outlier day doesn't
  wag the indicator.
- Trend chip in the header (mirrors the BP/weight `bg-muted/40` chip
  pattern) with arrow-icon + signed Δ-pp + "7-Tage-Trend" / "7-day
  trend" label. Metric-aware sentiment colour (rising compliance →
  green, falling → orange, stable < 1 pp → muted) — `up-good`
  semantics.
- Added a 100 % goal `ReferenceLine` (Dracula green, dashed) ALONGSIDE
  the existing 80 % minimum-acceptable threshold (Dracula yellow,
  paler dash). The two lines together visualise the target range the
  way HealthChart's targetZone band does for BP/weight tiles.

### Tests
- `src/components/charts/__tests__/medication-compliance-chart.test.tsx`
  — 6 new `computeMedicationTrend7d()` cases (empty, up, down, stable,
  14-day cap, short window). Empty-state assertion that the trend
  chip is suppressed when no data exists.

### Commit
`9b01c86` — `feat(charts): medication chart matches other charts (7d trend + indicator + target-range)`

## Constraint compliance

- Co-Author Claude Opus 4.7 on every commit ✓
- No `--no-verify` / `--no-gpg-sign` ✓
- Pre-commit hooks ran (none active in repo)
- Pushed to origin/main with `git pull --rebase --autostash` cycle ✓
- `pnpm test`: 1069 / 1069 green ✓
- `pnpm test:integration tests/integration/bp-in-target.test.ts`: 4 / 4
  green ✓
- `pnpm typecheck`: clean ✓
- `pnpm lint`: 12 warnings (baseline; 0 new) ✓

## Cross-agent commit-race artefact

The same v1.4.15 retrospective race recurred: my A6 commit
(`9b01c86`, 5 files) bundled-in the A7 agent's
`INSIGHTS_RATE_LIMIT_PER_HOUR` env var + cache-eviction work
(`.env.example`, `src/app/api/insights/generate/route.ts`,
`src/app/api/insights/generate/__tests__/route.test.ts`). I had only
explicitly `git add`-ed the two medication-chart files; the extras
appear to have been picked up by a `git commit` invocation between
sibling commits landing upstream. The work itself is correct (matches
the A7 brief), it's just under the wrong commit message. Per the
git-safety protocol I did NOT amend (would have lost A7's diff).

The recurring race is the v1.4.15 marathon meta — per-agent
worktrees would prevent it. Logged as a follow-up for the v1.4.16
process review.

## Files touched (mine only)

Created:
- `tests/integration/bp-in-target.test.ts`

Modified:
- `src/lib/analytics/bp-in-target.ts` (centralised predicate, new export)
- `src/lib/analytics/__tests__/bp-in-target.test.ts` (new tests)
- `src/lib/insights/blood-pressure-status.ts` (use helper)
- `src/lib/insights/features.ts` (use helper)
- `src/lib/insights/general-status.ts` (use helper)
- `src/app/api/insights/cards/route.ts` (use helper)
- `src/app/api/insights/comprehensive/route.ts` (use helper)
- `src/app/api/insights/targets/route.ts` (use helper)
- `src/components/charts/medication-compliance-chart.tsx` (A6 features)
- `src/components/charts/__tests__/medication-compliance-chart.test.tsx`

Commits on origin/main:
- `577d8dd` — A2 fix
- `9b01c86` — A6 feature (carries A7's diff inside, see race note)
