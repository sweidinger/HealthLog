# Phase D — SIMPLIFY review (v1.4.18)

Reviewer: simplify-auditor (one of six parallel D-phase reviewers)
Scope: `git diff --name-only v1.4.17...HEAD` (60 files, +5068 / -1685)
Tone: per CLAUDE.md — flag premature abstractions, defensive code that
can't fire, speculative options, what-comments, leftover shims, and
4+-callsite repetition. Empty list valid.

Findings below are ordered by impact. "Apply autonomously" = whether
the smell is mechanical enough that a follow-up patch can land without
fresh design discussion.

---

## F1 — Duplicate `DEFAULT_CHART_OVERLAY_PREFS` + parallel type

- **Files**:
  - `src/components/charts/chart-overlay-controls.tsx:49-56,164-168`
  - `src/lib/dashboard-layout.ts:121-131`
- **Type**: Repetition / parallel definition
- **Why it's a smell**: A3 declares `DEFAULT_CHART_OVERLAY_PREFS` in
  _two_ modules (one for the controls component, one for the layout
  resolver) with identical values. A second `ChartOverlayPrefsValue`
  interface in `chart-overlay-controls.tsx` mirrors `ChartOverlayPrefs`
  in `dashboard-layout.ts` field-for-field. Three modules
  (`chart-overlay-controls.tsx`, `use-chart-overlay-prefs.ts`,
  `dashboard-layout.ts`) each have one of the two copies; a fourth
  (`chart-overlay-controls.test.tsx`) imports the controls-side copy.
  If anyone ever adds a fourth toggle, half the surface will silently
  drift.
- **Suggested change**: Delete the constant + interface in
  `chart-overlay-controls.tsx` and re-export from `dashboard-layout.ts`
  (or have the controls component `import` the canonical type+default).
  `ChartOverlayControlsProps.prefs` becomes `ChartOverlayPrefs`.
- **Risk**: Very low — pure rename + re-import. Existing test imports
  `DEFAULT_CHART_OVERLAY_PREFS` from `chart-overlay-controls`; either
  keep the re-export or update the test (1 line).
- **Apply autonomously?**: yes

---

## F2 — `chartKey ?? "bp"` fallback feeds a hook whose result is then thrown away

- **File**: `src/components/charts/health-chart.tsx:321-324`
- **Type**: Defensive code that can't fire / odd contract
- **Why it's a smell**:
  ```ts
  const overlayPrefs = useChartOverlayPrefs(chartKey ?? "bp");
  const showMA = chartKey ? overlayPrefs.prefs.showTrendIndicator : false;
  const showTrend = chartKey ? overlayPrefs.prefs.showTrendArrow : false;
  const showBands = chartKey ? overlayPrefs.prefs.showTargetRange : false;
  ```
  When `chartKey` is undefined the hook is mounted against the **wrong
  key** ("bp"), and the resulting prefs are then discarded with the
  ternary. Net effect: an extra TanStack-Query subscription on the
  shared `["dashboard-layout"]` cache for every mini-mode chart
  instance, plus a contract where `useChartOverlayPrefs` looks like it
  wants a non-optional key but the caller fakes one. The mood-chart
  side handles the same case more cleanly via a default param
  (`chartKey = "mood"`) but only because it's a single-metric chart.
- **Suggested change**: Make `useChartOverlayPrefs` accept
  `ChartOverlayKey | null`; when null, return
  `{ prefs: DEFAULT_CHART_OVERLAY_PREFS, setPrefs: noop, isSaving: false }`
  without subscribing to the query. Caller becomes
  `useChartOverlayPrefs(chartKey ?? null)` and the three ternaries
  collapse to `overlayPrefs.prefs.show*`.
- **Risk**: Low — narrow change, covered by the existing
  `health-chart-overlay-defaults` test which already exercises the
  no-`chartKey` path.
- **Apply autonomously?**: yes

---

## F3 — `computeBpInTargetPct` + `computeBpInTargetWindows` both run on the same input

- **File**: `src/app/api/analytics/route.ts:84-107`
- **Type**: Speculative redundancy / future-proofing
- **Why it's a smell**: After A1, the headline `bpInTargetPct` is
  re-computed via `computeBpInTargetPct(sysData, diaData, …)` and
  _then_ `computeBpInTargetWindows(sysData, diaData, …, now)` runs
  again — its `last30Days.pct` is mathematically identical to the
  headline because both filter to the last 30 days and use the same
  pairing helper. The inline comment says the first call is "kept
  independent so a future refactor (e.g. headline → 'today's reading
  in target?') can move without breaking the sub-values" — that's
  speculative; today both fields are the same number.
- **Suggested change**: Drop the standalone `computeBpInTargetPct`
  call; set `bpInTargetPct = windows.last30Days?.pct ?? null` from
  the windows result. Keep the two exported helpers (they serve
  different unit-test surfaces). One DB-pair pass becomes one
  helper call instead of two.
- **Risk**: Low — pure refactor, the test suite covers both shapes.
  If the future "today's reading" pivot lands, that's the moment to
  reintroduce a separate helper.
- **Apply autonomously?**: yes

---

## F4 — Redundant `.map(...)` shaping prisma rows that already match the target type

- **File**: `src/app/api/gamification/achievements/route.ts:603-612`
- **Type**: Tiny noise
- **Why it's a smell**: The prisma `select` already pulls exactly
  `{ date, score, moodLoggedAt }` — the same three fields the
  `MoodEntryRecord` type declares — yet the route maps each row into
  a fresh object literal of the same shape before passing to
  `buildExpansionMetricValues`. Wasted allocation + 4 lines of noise.
- **Suggested change**: `moodEntries: moodEntries,` (or just inline
  the array). Type matches structurally.
- **Risk**: Trivial.
- **Apply autonomously?**: yes

---

## F5 — Unreachable defensive branch in `isEarnable`

- **File**: `src/lib/gamification/achievements.ts:794-838`
- **Type**: Defensive code that can't fire
- **Why it's a smell**: The five hidden-metric cases at the bottom
  (`nightOwlCount`, `earlyBirdCount`, `leapDayCount`, `doctorPdfCount`,
  `localeFlipCount`) carry a comment that explicitly says they're
  unreachable: hidden achievements are filtered by the
  `category === "hidden"` check earlier in `applyDiscoveryFilter`.
  The five-case fall-through exists only to keep TypeScript's
  exhaustive-switch happy. The function would be cleaner as an
  exhaustiveness-checked switch with the hidden cases mapped to the
  sentinel `assertNever` _or_ simply grouped with the other
  no-precondition `return true` block.
- **Suggested change**: Merge those 5 cases into the existing
  "no metric-data precondition" block (just append them after
  `weekendStreakCount`). Drop the duplicate comment.
- **Risk**: Low — semantically identical (`return true`); the
  existing comment already concedes this.
- **Apply autonomously?**: yes

---

## F6 — `getAchievementCategory` is a deprecation tag with no callers

- **File**: `src/lib/gamification/achievements.ts:132-142`
- **Type**: Backward-compat shim with no callers
- **Why it's a smell**: v1.4.18 introduced a private
  `categoryForMetric()` and made `category` a stored field on
  `AchievementDefinition`. The old `getAchievementCategory` export
  was kept "for legacy callers" — `grep -rn "getAchievementCategory"
src/ tests/ e2e/` shows zero callers outside the file itself.
- **Suggested change**: Delete the export and its JSDoc; rename
  `categoryForMetric` → `getAchievementCategory` if any external
  caller is anticipated, otherwise leave it private.
- **Risk**: Trivial — codebase-wide grep confirms no consumers.
- **Apply autonomously?**: yes

---

## F7 — Six "gradient removed" what-comments scattered through the chart wrappers

- **Files**:
  - `src/components/charts/health-chart.tsx:971-973, 1252-1253`
  - `src/components/charts/mood-chart.tsx:575, 782`
  - `src/components/charts/medication-compliance-chart.tsx:310, 425`
- **Type**: WHAT-not-WHY comments / scarring
- **Why it's a smell**: Every former `<defs>` and `<Area>` site got a
  `{/* v1.4.18 — gradient … removed; clean line only. */}` comment
  marking the absence. The git revert commit + memory
  `feedback_charts_visual_identity.md` already document the WHY; six
  in-tree breadcrumbs to a removed primitive read as scar tissue.
  Any new contributor reading the chart file does NOT need to know
  there used to be a gradient there.
- **Suggested change**: Delete all six. The chart-polish unit tests
  already pin the absence (`expect(html).not.toContain("chart-gradient-…")`).
- **Risk**: Trivial — pure comment removal.
- **Apply autonomously?**: yes

---

## F8 — `ChartOverlayPrefs` shape parallelism (considered + rejected)

- **File**: `src/lib/dashboard-layout.ts:121-125`
- **Type**: Marginal / shape-only observation, not a fix
- **Why it's _not_ a smell**: Three distinct toggle names (trendIndicator,
  trendArrow, targetRange) with three distinct semantics. Same shape
  across all five chart keys is intentional (every chart has the same
  three knobs). Per CLAUDE.md "speculative options" rule, this only
  becomes a problem if a future chart needs a _different_ set of
  toggles — at which point the per-chart prefs would need to vary
  anyway. Documented here to confirm I considered + rejected this.
- **Apply autonomously?**: n/a (no action)

---

## Cleanup verifications

- **A3 chart revert leftovers** — `src/components/charts/chart-gradient.tsx`
  is deleted (commit `008a8fb`); zero residual `import` references; the
  test references in `mood-chart-polish.test.tsx`,
  `medication-chart-polish.test.tsx`, and `health-chart-polish.test.tsx`
  are negative assertions (`expect(...).not.toContain(...)`) which
  should stay. **Clean.**
- **A2 no-scrollbar utility** — defined once in `globals.css:217-223`,
  consumed by `admin-shell.tsx:160` + `settings-shell.tsx:143`. No
  inline `scrollbar-width: none` duplication anywhere else. The two
  consumers carry their own (slightly different) justification
  comments, so they're not a copy-paste. **Clean.**
- **B1 evaluator pairs** — `getMoodMetrics`, `getEngagementMetrics`,
  `getHiddenMetrics`, `countMeasurementsByType`, `getEarnabilityFlags`
  are all exported and each have unit tests in
  `expansion-metrics.test.ts`. The single composite caller
  (`buildExpansionMetricValues`) is itself a route helper. Splitting
  was the right call — each helper is independently testable.
  **No simplification needed.**
- **`movingAverageByPoints` / `buildTrendLine` /
  `buildTrendSeriesByTime` duplication between `health-chart.tsx` and
  `mood-chart.tsx`** — flagged by `grep` but pre-dates v1.4.18
  (verified against `v1.4.17:src/components/charts/mood-chart.tsx`).
  Out of scope for this review.
- **`format === "percent"` dead branch** in
  `src/app/achievements/page.tsx:92` — no `ACHIEVEMENT_DEFINITIONS`
  entry uses `format: "percent"`, so the branch is dead. Pre-existed
  v1.4.18 (the branch lived in v1.4.17 too). Out of scope; flag for a
  future cleanup pass.

---

## Tally

- 7 actionable findings (F1–F7), all low-risk + autonomous-safe.
- 0 architectural rewrites required.
- 0 cross-file ripple risks.

done: 7 apply-yes, 0 apply-no
