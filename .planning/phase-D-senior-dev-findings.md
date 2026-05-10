# Phase D — Senior-Dev Architectural Review (v1.4.18)

Lens: structure, file size, naming, separation of concerns, layering. NOT
correctness or business logic — those are the code-reviewer's lane.

## Scope

Reviewed against `git diff --name-only v1.4.17...agent/b1-achievements` (the
worktree branch carrying the full v1.4.18 implementation: A1 + A2 already on
`main`, A3 charts revert + B1 achievements expansion sitting on the agent
branches awaiting reconcile). 59 files / +4961 -1612 LOC.

Files inspected closest:

- `src/lib/analytics/bp-in-target.ts` (A1 windowed helper)
- `src/app/api/analytics/route.ts` (A1 wiring)
- `src/app/page.tsx` (A1 tile wiring)
- `src/app/globals.css` + admin/settings shells (A2 no-scrollbar)
- `src/components/charts/health-chart.tsx` / `mood-chart.tsx` /
  `medication-compliance-chart.tsx` (A3 revert + overlay-controls)
- `src/components/charts/chart-overlay-controls.tsx` + `use-chart-overlay-prefs.ts`
- `src/lib/dashboard-layout.ts` (overlay prefs persistence)
- `src/app/api/dashboard/chart-overlay-prefs/route.ts` (overlay PUT)
- `src/lib/gamification/achievements.ts` (B1 definitions + evaluators)
- `src/lib/gamification/expansion-metrics.ts` (B1 expansion engine)
- `src/app/api/gamification/achievements/route.ts` (B1 route stitching)
- `src/app/achievements/page.tsx` + `src/components/gamification/*`
- All companion unit + integration + e2e tests

Lines-of-code deltas v1.4.17 → v1.4.18:

| File                                                    | v1.4.17 | v1.4.18 |    Δ |
| ------------------------------------------------------- | ------: | ------: | ---: |
| `src/components/charts/health-chart.tsx`                |    1431 |    1339 |  -92 |
| `src/components/charts/mood-chart.tsx`                  |     958 |     850 | -108 |
| `src/components/charts/medication-compliance-chart.tsx` |     466 |     444 |  -22 |
| `src/lib/gamification/achievements.ts`                  |     431 |     839 | +408 |
| `src/lib/gamification/expansion-metrics.ts`             |       ─ |     374 | +374 |
| `src/app/api/gamification/achievements/route.ts`        |     776 |     876 | +100 |
| `src/app/achievements/page.tsx`                         |     388 |     441 |  +53 |
| `src/lib/dashboard-layout.ts`                           |     200 |     287 |  +87 |
| `src/lib/analytics/bp-in-target.ts`                     |     178 |     230 |  +52 |

Charts shrunk after the revert (good — gradient primitive deletion +
emoji-glyph removal more than offset the new overlay-control mounts).
Gamification grew on the data side (definitions doubled from ~14 to
38 badges) but the new code lives in two coherent files (`achievements.ts`

- `expansion-metrics.ts`) with a clear definition / evaluator split.

## Findings

### F1 — `ChartOverlayPrefs` type duplicated under two names

- **Severity:** MED
- **File:** `src/components/charts/chart-overlay-controls.tsx` (line 49,
  exports `ChartOverlayPrefsValue` + `DEFAULT_CHART_OVERLAY_PREFS`) vs
  `src/lib/dashboard-layout.ts` (line 121, exports `ChartOverlayPrefs` +
  `DEFAULT_CHART_OVERLAY_PREFS`)
- **Issue:** Two parallel exports with **identical** shape (3 booleans
  named `showTrendIndicator` / `showTrendArrow` / `showTargetRange`) live
  in two files under two type names. Both also re-export a
  `DEFAULT_CHART_OVERLAY_PREFS` constant — luckily with the same
  defaults, but a future drift between them would compile (structural
  typing) yet ship incoherent UI vs server defaults. The two typenames
  are reachable from the same call graph (`use-chart-overlay-prefs.ts`
  imports from `dashboard-layout`; `chart-overlay-controls.tsx`
  declares its own), so a reviewer reading the chart's render path now
  has to switch between `ChartOverlayPrefs` and
  `ChartOverlayPrefsValue` mentally.
- **Recommendation:** Drop the duplicate from
  `chart-overlay-controls.tsx` and re-import `ChartOverlayPrefs` +
  `DEFAULT_CHART_OVERLAY_PREFS` from `@/lib/dashboard-layout` (the
  canonical home). 5-line change. The `ChartOverlayPrefsValue` name was
  presumably introduced because the controls component pre-dated the
  persistence layer; now that `dashboard-layout` is the source of
  truth, the duplicate is dead weight.
- **Ship-blocker:** No.

### F2 — `getAchievementCategory` deprecated but kept as a public export

- **Severity:** LOW
- **File:** `src/lib/gamification/achievements.ts` (line ~136-141)
- **Issue:**
  ```ts
  /**
   * @deprecated kept only for legacy callers; new code should read
   * `AchievementDefinition.category` directly. v1.4.18 made category a
   * stored field on the definition so hidden Easter-eggs (which share
   * metrics with no other badge) don't need a special case.
   */
  export function getAchievementCategory(...)
  ```
  The JSDoc says "legacy callers" but `git grep` shows zero call sites
  outside the test suite — the new design stores `category` on the
  definition row directly, so the function is purely vestigial. Keeping
  a `@deprecated` symbol public invites new code to reach for it.
- **Recommendation:** Either un-export it (rename to `categoryForMetric`
  internal-only — already exists alongside it) and delete the
  re-exported wrapper, or move it behind an `__internal__/` boundary.
  This is a mild premature-abstraction red flag flagged in the brief
  — the v1.4.18 refactor created the right thing (`category` stored on
  the definition) but kept the old door open out of caution.
- **Ship-blocker:** No.

### F3 — `src/lib/gamification/achievements.ts` (839 LOC) approaching the "definitions/ + evaluators/ + utilities/" split threshold

- **Severity:** LOW
- **File:** `src/lib/gamification/achievements.ts`
- **Issue:** The file currently houses (in order): types,
  `categoryForMetric`, `ACHIEVEMENT_CATEGORY_ORDER`, the `metrics`
  interface, the `AchievementProgress` type, `BERLIN` formatters, the
  `STREAK_TARGETS` + `buildStreakAchievements` factory, the `define()`
  helper, the **38 definition literals** (~530 LOC of the file),
  `dayKeyToNumber` / `toBerlinDayKey` / `getUniqueBerlinDays` /
  `calculateLongestStreak`, the `evaluateAchievementsWithCompletionDates`
  evaluator, and the `applyDiscoveryFilter` + `isEarnable` filter.
  That's 4 distinct responsibilities (types, definitions data, day-key
  utilities, evaluator+filter logic) under one roof. At 839 LOC it's
  still readable, but the brief asked specifically: "is
  `src/lib/achievements/` still coherent or does it need sub-folders
  (definitions/ evaluators/ ui/)?". Today it is one file under
  `gamification/`, not a folder.
- **Recommendation:** Defer the split to the first time we add a 5th
  responsibility (e.g. a server-side rules engine, a cross-user leaderboard
  aggregator, etc.). Right now the four halves are short enough that
  inlining is faster to navigate than chasing imports across 4 files. If
  a split is forced earlier, the natural cut points are:
  - `gamification/achievements/definitions.ts` (the literal array +
    `define()` factory)
  - `gamification/achievements/evaluator.ts`
    (`evaluateAchievementsWithCompletionDates`)
  - `gamification/achievements/discovery.ts` (`applyDiscoveryFilter` +
    `isEarnable` + `EarnabilityFlags`)
  - `gamification/achievements/day-keys.ts` (`toBerlinDayKey`,
    `calculateLongestStreak`, etc. — could even hoist to
    `lib/dates/berlin-day-keys.ts` since `bp-in-target.ts` reimplements
    `toBerlinDayKey` separately, see F4)
- **Ship-blocker:** No.

### F4 — `toBerlinDayKey()` reimplemented in two places

- **Severity:** LOW
- **Files:** `src/lib/analytics/bp-in-target.ts` (line 70) and
  `src/lib/gamification/achievements.ts` (line ~680)
- **Issue:** Both files independently roll an `Intl.DateTimeFormat` with
  `timeZone: "Europe/Berlin"` formatter and a `toBerlinDayKey()` helper
  that returns `YYYY-MM-DD`. The bp-in-target version uses the en-CA
  locale shortcut (`format()` returns `YYYY-MM-DD` directly); the
  achievements version uses `formatToParts()` and stitches the parts
  manually. Functionally identical, but the duplication means a future
  timezone bug (DST edge, year-rollover, etc.) has to be fixed in two
  places. `expansion-metrics.ts` re-imports from `achievements.ts` so it
  doesn't add a third copy — but the two existing ones are independent.
- **Recommendation:** Promote one of them to a shared helper, e.g.
  `src/lib/dates/berlin-day-key.ts` exporting `toBerlinDayKey()` +
  `getUniqueBerlinDays()` + `calculateLongestStreak()`. Both achievements
  and bp-in-target depend on it. Defer the move until a third caller
  arrives — two copies aren't yet a smell, but `git grep "Europe/Berlin"`
  inside `src/lib/` already finds 8+ matches across helpers, so the
  pattern is recurring.
- **Ship-blocker:** No.

### F5 — Achievements route wears too many hats

- **Severity:** LOW
- **File:** `src/app/api/gamification/achievements/route.ts` (876 LOC)
- **Issue:** The route now mixes:
  - 12 prisma queries with `Promise.all`
  - 7 derived helpers (`getEventDaySeries`, `getHealthGreenDaySeries`,
    `getOnTimePerfectDaySeries`, `getCompliance80DaySeries`,
    `getIntakeIssueMetrics`, `findCountCompletionDate`,
    `findStreakCompletionDate`) inlined as private functions
  - The completion-date stitching logic (a 130-line `for...of
ACHIEVEMENT_DEFINITIONS` switch over each metric)
  - Discovery-filter-aware summary recomputation
  - iOS-format vs default-format response shape branch
    At 876 LOC this is the largest API route in the codebase. The
    v1.4.18 expansion grew it by 100 lines, and the next time a metric
    type lands the same `if (definition.metric === "X")` chain extends.
- **Recommendation:** Extract the inlined helpers to
  `src/lib/gamification/route-helpers.ts` so the route stays
  responsible for "fetch + serialise" and the metric pipeline is
  testable in isolation. The integration test file already calls out
  it can't drive the full route end-to-end (pre-existing
  `medication_schedules.days_of_week` migration drift) and falls back
  to direct calls into `buildExpansionMetricValues` —
  pulling those helpers into `route-helpers.ts` would let the
  integration test exercise _all_ the route logic, not just the
  expansion bits.
- **Ship-blocker:** No (but the trajectory deserves a note for the
  v1.4.19 backlog).

### F6 — Hidden-discovery branch is dead-code defensive

- **Severity:** LOW
- **File:** `src/lib/gamification/achievements.ts` (line ~828)
- **Issue:**
  ```ts
  case "nightOwlCount":
  case "earlyBirdCount":
  case "leapDayCount":
  case "doctorPdfCount":
  case "localeFlipCount":
    // Hidden achievements are filtered by category check above; this
    // branch is only reached if a hidden definition's category got
    // misconfigured. Stay defensive.
    return true;
  ```
  This is exactly the "defensive code that can't fire" pattern the
  brief calls out. The comment admits it: the `applyDiscoveryFilter`
  short-circuit at line ~796 (`if (item.category === "hidden") return
true`) already covers every hidden definition, because the `define()`
  helper hard-codes `category: isHidden ? "hidden" : ...`. The only way
  this branch fires is if the `define()` helper itself breaks — which
  has zero test coverage on this path.
- **Recommendation:** Either drop the case entries entirely (the
  `switch` would then exhaust under `noImplicitReturn` thanks to the
  exhaustive-check on `AchievementMetricKey`, which is what we want —
  any new hidden metric SHOULD force a category review at compile
  time) or drop the comment and leave the case but with `throw new
Error("hidden metric reached non-hidden filter — broken define()")`
  to make the dead branch loud-fail rather than silent-pass.
- **Ship-blocker:** No.

### F7 — Mobile-strip fix lives at module level, but applies to TWO shells

- **Severity:** INFO
- **File:** `src/app/globals.css` (lines 217-223) +
  `src/components/admin/admin-shell.tsx` (line 160) +
  `src/components/settings/settings-shell.tsx` (line 143)
- **Issue:** The `no-scrollbar` utility is correctly consolidated to
  ONE place (globals.css) and consumed by both shells via the same
  class name — that is the right architecture. The shells themselves
  duplicate the surrounding `<nav className="no-scrollbar -mx-4 mb-4
overflow-x-auto px-4 md:hidden">` markup verbatim though, with
  similar `<ul className="flex min-w-max gap-2">` wrappers and similar
  pill-button classes. Two near-identical components.
- **Recommendation:** Defer. The shells legitimately differ on the
  active-slug match path (`/admin/<slug>` regex returns `null` for
  `/admin`; `/settings/<slug>` falls back to `"account"`) and the
  desktop sidebar adds an "Overview" link in admin only. Sharing the
  wrapper would require parameterising both behaviours. The 90 % code
  overlap is the right amount of duplication for two surfaces that
  read similar but mean different things — the alternative is a 5-prop
  `<SectionShell>` that nobody else uses. Note for v1.5+ if a third
  section shell shows up.
- **Ship-blocker:** No.

### F8 — `findClosestDia` is O(n·m); dataset stays small enough that it's fine

- **Severity:** INFO
- **File:** `src/lib/analytics/bp-in-target.ts` (line 80)
- **Issue:** For each sys reading we scan the full dia array
  (`O(n·m)`). With Marc's actual fixture (10 paired readings over
  30 days, 250 paired over 30 days for a Withings-paired user) this is
  fine. At 10k readings (a multi-year backfill replayed in one shot)
  the route would slow noticeably. The function isn't part of any
  background job — only the analytics route — and the route already
  caps at 30 days, so the worst case is hundreds of readings, not
  tens of thousands.
- **Recommendation:** No change. If a future "comprehensive" or
  multi-year insight surface ever uses this helper, swap to a pre-sorted
  dia array + binary search. Pin a benchmark test if/when that moves.
- **Ship-blocker:** No.

## Cross-cutting checks

- **Logging via `annotate()`:** Verified. The new
  `/api/dashboard/chart-overlay-prefs` route and the analytics route
  both call `annotate({ action: { name: "..." } })` on the success
  path. The achievements route already had its annotation in v1.4.17
  and the v1.4.18 patch didn't drop it.
- **Errors via `HttpError`:** The new overlay-prefs route uses
  `apiError("...", 422)` for Zod validation failures (the canonical
  pattern across the codebase) instead of throwing — same approach as
  the rest of `/api/dashboard/*`. Consistent.
- **Sensitive data via `crypto.ts`:** v1.4.18 introduces no new
  encryption-relevant paths. Achievements + chart-overlay-prefs are
  both plain-text user prefs persisted on `User.dashboardWidgetsJson`,
  no PHI / token material at rest. Correct call.
- **Test architecture:**
  - `src/lib/gamification/__tests__/expansion-metrics.test.ts` (280
    LOC) covers all 5 evaluator helpers with table-driven cases.
  - `src/lib/gamification/__tests__/achievements.test.ts` (191 LOC)
    covers the discovery filter (3 exception paths) + category
    grouping.
  - `tests/integration/achievements-expansion.test.ts` (180 LOC) uses
    `getPrismaClient()` + `truncateAllTables()` — the testcontainer
    setup mandated by `CLAUDE.md`. Same shape as the v1.4.17
    integration suite.
  - `tests/integration/chart-overlay-prefs.test.ts` (182 LOC) — same
    testcontainer setup; covers the resolver coercion path for
    malformed PUT bodies.
  - `tests/integration/bp-in-target.test.ts` (+169 LOC for the new
    windowed cases) — extends the existing testcontainer suite.
  - `e2e/achievements.spec.ts` and `e2e/chart-overlay-controls.spec.ts`
    extend the Playwright + axe-core suite per `CLAUDE.md`.
    Test coverage is comprehensive and matches the testing convention.

## TODO/FIXME inventory in v1.4.18-changed files

`grep -nE "(TODO|FIXME|HACK|XXX)"` across the 59 changed source files
returns **zero** matches. No deferred-work markers landed in this
release. Clean.

## Best-practice red flags

- **Premature abstraction:** Mild — F2 (deprecated wrapper kept) + F6
  (defensive switch case for an impossible branch). Nothing
  load-bearing.
- **Defensive code that can't fire:** F6 only.
- **Comments paraphrasing code:** None found. Comments overwhelmingly
  explain _why_ (regression history, Marc-feedback links, design
  rationale) — exactly the codebase house style.
- **Backward-compat shims:** The analytics route header comment calls
  out the headline `bpInTargetPct` is "kept for backward compatibility
  with cached client bundles" while the new windowed fields are
  surfaced alongside it. That's a deliberate, documented additive
  change — not a stale shim. Verified: `grep -rn bpInTargetPct\b src/`
  shows the headline is read by the dashboard tile (latest), the
  insight-card (BP status), and the analytics route itself. Removing it
  before the cache-bust window would 500 a fresh-deploy / stale-cache
  client. Correct call.
- **API additive vs. shape break (A1):** The bp-in-target route
  payload extension is purely additive (new optional `bpInTargetPct7d`
  - `bpInTargetPct30d` fields, headline `bpInTargetPct` unchanged).
    The dashboard `AnalyticsData` interface declares them
    optional-undefined. Old clients on stale bundles who only read the
    headline see the same value they used to. New clients fall through
    to "—" when the field is undefined. **No partial-view hazard.**

## Summary

CRITICAL: 0
HIGH: 0
MED: 1 (F1 type duplication)
LOW: 5 (F2 deprecated export, F3 file-size watchpoint, F4 day-key
duplication, F5 route extraction watchpoint, F6 dead defensive branch)
INFO: 2 (F7 shell duplication watchpoint, F8 perf O(n·m) note)

v1.4.18 is architecturally clean. The achievements expansion adds
significant data (38 definitions across 6 categories, 5 expansion
metric helpers, hidden Easter-egg discovery filter) without breaking
the existing module shape — the new `expansion-metrics.ts` is a clean
counterpart to `achievements.ts`, both are pure functions over typed
prisma rows, and both have unit + integration coverage.

The chart revert is clean — `chart-gradient.tsx` is _deleted_ (not
deprecated-and-left-behind), the new `chart-overlay-controls.tsx` is
controlled-component-only (parent owns state), persistence piggy-backs
on the existing `dashboardWidgetsJson` blob (consistent with B8
comparison-baseline + earlier widget patterns).

A2's `no-scrollbar` utility is consolidated to ONE definition in
`globals.css` and applied at both shell call-sites with identical
markup. Single source of truth ✅.

A1 extends the analytics route additively — old field
(`bpInTargetPct`) preserved, new windowed fields
(`bpInTargetPct7d`, `bpInTargetPct30d`) added. Zero partial-view
hazard for stale clients.

No CRITICAL findings. No ship-blockers.
