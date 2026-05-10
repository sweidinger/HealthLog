# v1.4.18 Phase-D Code Review Findings

Reviewer: code-reviewer agent
Run: 2026-05-10 (parallel with 5 other reviewers)
Scope: v1.4.17 → origin/main (22 commits)
DO NOT commit — findings only.

Diff scope (from `git log --oneline v1.4.17..origin/main`):

- A1 BD-Zielbereich tile sub-values (commits 23363ca, 15c852f)
- A2 painted-scrollbar fix (commits 3e16074, 874878f)
- A3 chart visual revert + per-chart toggles (commits 008a8fb, 06f18df, b388fc0, 75f340e, d70a9b1, 3d58557, d6e87c3)
- B1 achievements expansion + hidden Easter-eggs (commits e73813a, 19b0844, c41f9a4, 23514b4, b88f2de, 6912d4e, 75c74f1, 178c6dc)

## CRITICAL

### C1 — Hidden achievement triggers leak via the API response (and the client bundle)

- **Severity**: CRITICAL
- **File**: `src/app/api/gamification/achievements/route.ts:611-655` and
  `src/lib/gamification/achievements.ts:706-739` (evaluator) +
  `src/lib/i18n/context.tsx:15-22` (bundle import)
- **Issue**: The reviewer brief lists this exact failure mode as ship-
  blocker: _"the 'Hidden' placeholder must not reveal predicate
  conditions to a snooping user"_. The achievements page UI does the
  right thing — `<AchievementCard>` for hidden+locked entries renders
  an opaque card with only a generic "Hidden achievement" label and
  the help-circle icon. **However, the wire response from
  `GET /api/gamification/achievements` ships the full achievement
  definition for every entry including hidden+locked**:

  ```json
  {
    "id": "hidden-night-owl",
    "metric": "nightOwlCount",
    "category": "hidden",
    "titleKey": "achievements.badges.hiddenNightOwl.title",
    "descriptionKey": "achievements.badges.hiddenNightOwl.description",
    "icon": "Moon",
    "format": "count",
    "target": 1,
    "current": 0,
    "points": 25,
    "unlocked": false,
    "progressPercent": 0,
    "completedAt": null,
    "isHidden": true
  }
  ```

  Three independent leak vectors a "snooping user" can use without any
  privileged access:
  1. The metric name itself (`nightOwlCount`, `earlyBirdCount`,
     `leapDayCount`, `doctorPdfCount`, `localeFlipCount`) leaks the
     trigger semantically.
  2. The `titleKey` / `descriptionKey` strings reference the i18n
     bucket whose translated values describe the trigger verbatim
     (`"Logged an entry between 02:00 and 04:00 in the morning."`).
  3. `messages/en.json` and `messages/de.json` are statically
     `import`-ed in `src/lib/i18n/context.tsx` (lines 15-16) and
     therefore bundled into the client JS — a `Cmd-F` for
     `"hiddenNightOwl"` in the chunk reveals every trigger and
     reward.
     Items 1+2 are the ship-blocker the brief explicitly asks for. Item 3
     is a related but separable concern that needs a different fix.

  Critically, the `<AchievementCard>` opaque-placeholder branch makes
  this leakage _less obvious to casual users_ but does nothing to
  prevent a determined snooper — Marc, who specifically asked for
  hidden Easter-eggs to be a surprise, would discover them in 30
  seconds with the Network tab open.

  Existing test coverage (`src/app/achievements/__tests__/page.test.tsx`
  lines 254-270) only asserts that the rendered HTML doesn't contain
  the strings — _that test passes_ even though the strings are still
  in the JSON response and the bundle. The test is not actually
  guarding what the brief asked us to guard.

- **Recommendation**: Strip identifying fields from hidden+locked
  achievement entries server-side before returning them. The wire
  shape for a hidden+locked entry should look like:

  ```json
  {
    "id": "hidden-night-owl",
    "category": "hidden",
    "isHidden": true,
    "unlocked": false,
    "completedAt": null
  }
  ```

  i.e. drop `metric`, `titleKey`, `descriptionKey`, `icon`, `target`,
  `current`, `progressPercent`, `points`. A stable `id` is fine to
  expose because the i18n key is namespaced under `hidden*` (the user
  can still infer that hidden achievements exist; that's the whole
  point) but the trigger details must not be transmitted.

  Concretely, in `src/app/api/gamification/achievements/route.ts`
  around line 611 (where `applyDiscoveryFilter` is called), add a
  second pass that scrubs hidden+locked entries before serialising:

  ```ts
  const sanitized = visibleAchievements.map((a) => {
    if (a.isHidden && !a.unlocked) {
      return {
        id: a.id,
        category: "hidden" as const,
        isHidden: true,
        unlocked: false,
        completedAt: null,
        // Synthetic placeholders for type-stability so the client
        // doesn't need an `?.` everywhere. The real strings only
        // ship once the achievement unlocks.
        titleKey: "achievements.hiddenCard.title",
        descriptionKey: "achievements.hiddenCard.description",
        icon: "HelpCircle",
        format: "count" as const,
        target: 0,
        current: 0,
        points: 0,
        metric: "totalTakenIntakes" as const, // sentinel
        progressPercent: 0,
      };
    }
    return a;
  });
  ```

  And add an explicit test at the API/route level that asserts the
  response body does NOT contain `nightOwlCount`, `earlyBirdCount`,
  `leapDayCount`, `doctorPdfCount`, `localeFlipCount` while the
  achievement is locked, and DOES contain those strings once
  unlocked.

  Bundle leak (item 3) is a separate fix: gate hidden i18n strings
  behind a server-side translator and return the resolved title /
  description in the unlock toast payload only when the unlock
  actually occurs (or move them to a server-only translation file
  loaded by `getServerTranslator`). Lower-effort interim is a comment
  in `messages/*.json` explaining the trade-off and accepting that
  any client-bundle leak below the API leak is "acceptable risk for
  v1.4.18" — but that's a Marc-call, not a reviewer-call.

- **Ship-blocker?**: YES. The brief explicitly calls this out as
  CRITICAL ("hidden achievement leakage in DOM/network responses").
  The DOM leak is fixed (the card renders correctly); the **network
  response leak is not**. This must be fixed before v1.4.18 ships.

## HIGH

### H1 — Read-modify-write race when two charts toggle overlays simultaneously

- **Severity**: HIGH (correctness — concurrent writes lose data)
- **File**: `src/app/api/dashboard/chart-overlay-prefs/route.ts:55-79`
  and `src/app/api/dashboard/widgets/route.ts:96-115`
- **Issue**: Both routes do an unwrapped read-modify-write against
  `User.dashboardWidgetsJson`:

  ```ts
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { dashboardWidgetsJson: true },
  });
  const current = resolveDashboardLayout(row?.dashboardWidgetsJson);
  const next: DashboardLayout = {
    ...current,
    chartOverlayPrefs: {
      ...(current.chartOverlayPrefs ?? {}),
      [parsed.data.chartKey]: parsed.data.prefs,
    },
  };
  await prisma.user.update({
    where: { id: user.id },
    data: { dashboardWidgetsJson: normalized },
  });
  ```

  If a user opens the dashboard, flips the BP chart's "Target range"
  toggle, and 50ms later flips the weight chart's "Trend" toggle, the
  two `PUT` calls can interleave: BP-PUT reads the current layout,
  weight-PUT reads the _same_ current layout (concurrent), BP-PUT
  writes the merged BP prefs, weight-PUT then writes its merged
  weight prefs back **on top of the layout it read** — which still
  has the old BP prefs — silently dropping the BP toggle. The user
  sees the BP toggle revert when the page next refreshes.

  The optimistic update in `useChartOverlayPrefs` (`onMutate`)
  partially masks this for the originating client because the local
  cache stays correct until the route returns; once the route
  returns successful and `onSettled` invalidates the query, the next
  fetch reveals the dropped toggle.

  The same race exists for `/api/dashboard/widgets` PUT (already had
  this defect in v1.4.16 + B8 comparison baseline) but the new chart-
  overlay-prefs route makes it worse because the surface for
  per-chart toggles is exactly the kind of thing users will
  rapid-fire (5 charts × 3 toggles = 15 settings to flip in a
  session).

- **Recommendation**: Wrap the read-modify-write in a transaction
  with `SERIALIZABLE` isolation OR rewrite the merge to use Postgres'
  JSON path operators so the SQL itself is the merge. Cheapest fix
  is the transaction wrapper:

  ```ts
  await prisma.$transaction(
    async (tx) => {
      const row = await tx.user.findUnique({
        where: { id: user.id },
        select: { dashboardWidgetsJson: true },
      });
      const current = resolveDashboardLayout(row?.dashboardWidgetsJson);
      const next = {
        ...current,
        chartOverlayPrefs: {
          ...(current.chartOverlayPrefs ?? {}),
          [parsed.data.chartKey]: parsed.data.prefs,
        },
      };
      await tx.user.update({
        where: { id: user.id },
        data: {
          dashboardWidgetsJson: serializeDashboardLayout(
            next,
          ) as Prisma.InputJsonValue,
        },
      });
    },
    { isolationLevel: "Serializable" },
  );
  ```

  Add a vitest race-condition test against the existing testcontainer
  setup (mirror `tests/integration/rate-limit-race.test.ts`). The
  existing v1.4.18 integration test
  (`tests/integration/chart-overlay-prefs.test.ts`) only exercises
  serial writes and would not catch this defect.

- **Ship-blocker?**: NO — single-user, single-tab usage will not
  trigger this (the optimistic update masks it). But a user with the
  dashboard open in two tabs (a common pattern with PWAs) WILL hit
  it. Fix in v1.4.18 if Marc wants; safe to defer to v1.4.19 with a
  backlog entry.

### H2 — `useChartOverlayPrefs` subscribes to "bp" prefs even when no chartKey is supplied

- **Severity**: HIGH (correctness — wrong overlay state when chartKey is omitted)
- **File**: `src/components/charts/health-chart.tsx:321-324`
- **Issue**:

  ```ts
  const overlayPrefs = useChartOverlayPrefs(chartKey ?? "bp");
  const showMA = chartKey ? overlayPrefs.prefs.showTrendIndicator : false;
  const showTrend = chartKey ? overlayPrefs.prefs.showTrendArrow : false;
  const showBands = chartKey ? overlayPrefs.prefs.showTargetRange : false;
  ```

  When `chartKey` is undefined (mini mode / ad-hoc render), the hook
  still subscribes to the dashboard-layout query and reads the
  user's `bp` chart prefs — which are then ignored by the ternaries.
  This is mostly wasteful (an extra fetch + reactive subscription),
  but it has two real consequences:
  1. A render thrash when the user updates BP chart prefs from the
     dashboard: every mini chart re-renders even though their state
     doesn't change.
  2. If a user has no `bp` prefs but has `weight` prefs, the
     defaulted-empty `bp` prefs leak through the optimistic-update
     cache as "every flag false" — usually equivalent to the
     correct default but conceptually wrong.

- **Recommendation**: Either pass `chartKey` to the hook only when
  defined and short-circuit inside the hook when undefined, or move
  the hook call inside a wrapper that early-exits before the hook is
  called (the latter is a hooks-rule violation though, so prefer the
  former):

  ```ts
  // In use-chart-overlay-prefs.ts:
  export function useChartOverlayPrefs(
    chartKey: ChartOverlayKey | undefined,
  ): { prefs: ChartOverlayPrefs; setPrefs: ...; isSaving: boolean } {
    const queryClient = useQueryClient();
    const { data: layout } = useQuery({
      queryKey: ["dashboard-layout"],
      enabled: chartKey !== undefined, // skip when no key
      ...
    });
    const prefs = useMemo<ChartOverlayPrefs>(() => {
      if (!chartKey) return DEFAULT_CHART_OVERLAY_PREFS;
      return layout?.chartOverlayPrefs?.[chartKey] ?? DEFAULT_CHART_OVERLAY_PREFS;
    }, [layout, chartKey]);
    ...
  }
  ```

- **Ship-blocker?**: NO — the user-visible behaviour is the clean-line
  default (which is correct). Wasted bandwidth + re-render only.

### H3 — Hidden bug-buddy achievement shares `bugReportCount` with public bugreport-1 — order-of-evaluation matters

- **Severity**: HIGH (correctness around discovery)
- **File**: `src/lib/gamification/achievements.ts:354-375` (public
  `bugreport-1`) and lines 638-647 (hidden `hidden-bug-buddy`)
- **Issue**: Both achievements use `metric: "bugReportCount"`. The
  public one fires at target 1; the hidden one fires at target 5.
  When the API response is serialised, both entries have
  `metric: "bugReportCount"` but different `target` values. A snooper
  comparing the two entries discovers that **the hidden achievement
  shares the same metric as the public one but with a higher
  threshold** — i.e. the trigger is "submit 5 bug reports".

  This is an even-worse leak than the metric-name leak (C1) because
  the cross-reference is trivial: open the page, see one public
  bugreport badge with `target: 1`, and one hidden badge with
  `metric: "bugReportCount"` and `target: 5` — game over for the
  surprise.

- **Recommendation**: Fix subsumed by C1 (don't ship `metric` or
  `target` for hidden+locked entries). With C1 fixed, this leak goes
  away.

  As a separate consideration: the design choice of reusing a public
  metric for a hidden Easter-egg is questionable to begin with —
  consider giving the hidden bug-buddy its own metric
  (`bugReportCountHidden` or similar), so even server-side audit
  trails don't accidentally reveal that "5 bug reports" is the
  trigger via shared metric counting.

- **Ship-blocker?**: NO once C1 ships. Tracked under C1 fix.

### H4 — `getMoodMetrics` improvement-window slices distinct days, not 7 calendar days

- **Severity**: HIGH (correctness — diverges from "7-day window" semantics)
- **File**: `src/lib/gamification/expansion-metrics.ts:104-138`
- **Issue**: `moodImprovementHit` slides a 7-distinct-day window
  rather than a 7-calendar-day window:

  ```ts
  for (let i = 13; i < sortedDays.length; i++) {
    const recent = sortedDays.slice(i - 6, i + 1);  // 7 distinct days
    const prior = sortedDays.slice(i - 13, i - 6);  // 7 distinct days
    ...
  }
  ```

  If a user logs daily for a month, that's fine. But a user who logs
  on April 1, 2, 3, 4, 5, 6, 7, then nothing for a month, then
  May 1, 2, 3, 4, 5, 6, 7 will have the comparison fire across the
  one-month gap — comparing two arbitrarily-spaced 7-entry sets, not
  two contiguous 7-day windows.

  The doc-comment claims _"any 7-day window had a mean score at least
  1.0 higher than the preceding 7-day window"_ (line 96) which is
  **NOT** what the code does.

  Practical impact: the achievement may unlock too eagerly for users
  with sparse logging patterns. Not coercive (Marc's design rule is
  satisfied), but the semantics are wrong.

- **Recommendation**: Either:
  - Update the doc-comment to say "compares the last 7 entries to the
    7 preceding entries" and accept the simplification, OR
  - Make the window calendar-day-based: build a daily array including
    no-data days (or a `null` for missing), require a minimum number
    of populated days in each window, then compute the means.

  The first option is cheaper and probably what Marc actually wants
  ("user is moving in the right direction"); the second is more
  rigorous but adds complexity.

  Either way, add a unit test for the cross-month-gap case to lock
  in the chosen semantics.

- **Ship-blocker?**: NO — the achievement still functions and it's
  user-positive (not coercive). Document or fix in a follow-up.

### H5 — `consistentMonthCount` keeps growing — wasted DB churn for once-fired achievement

- **Severity**: HIGH (DB wear on long-tenured users)
- **File**: `src/lib/gamification/expansion-metrics.ts:175-182` and
  `src/app/api/gamification/achievements/route.ts:601-610`
  (persistence flow)
- **Issue**: `consistentMonthCount` returns the _total_ number of
  consistent months over the user's entire history. The achievement
  unlocks at target 1 (first consistent month), but the metric keeps
  incrementing every month thereafter. Each new consistent month
  causes:
  1. Recompute on every `/api/gamification/achievements` call
     (every 2 minutes via `<AchievementUnlockNotifier>` polling)
  2. The `metrics.consistentMonthCount` column grows unboundedly
     in the response payload (a small int, but conceptually unbounded)
  3. No corresponding state in the UI exposes this count

  Compare to `moodEntryCount`, which does have multi-tier
  achievements at 1 / 50 / 200 etc. — so the unbounded growth there
  is justified.

- **Recommendation**: Either:
  - Add tiered achievements at consistent-month 1 / 3 / 6 / 12 to
    justify the growing count, OR
  - Cap the count at the highest threshold (`min(count, 1)`) inside
    `getEngagementMetrics()` to make the metric effectively boolean
    and stop the growth.

  Same review applies to `moodImprovementHit` (already capped at 1
  by the `break;`), `nightOwlCount` (counted but no tiered targets
  beyond 1), `earlyBirdCount`, `leapDayCount`, `doctorPdfCount`,
  `localeFlipCount`. Consider capping all single-target hidden
  metrics at 1 to limit the wire-payload growth and avoid a future
  "did the user trigger this 100 times?" question that the data
  doesn't actually answer.

- **Ship-blocker?**: NO. Pure efficiency / hygiene, no incorrect
  user-facing behaviour.

## MEDIUM / LOW

### M1 — Earnability flags treat `BLOOD_PRESSURE_DIA`-only users as having no BP data

- **Severity**: MEDIUM
- **File**: `src/lib/gamification/expansion-metrics.ts:74-83`
- **Issue**: `countMeasurementsByType` counts only `BLOOD_PRESSURE_SYS`
  toward `bpCount`. If a user (or a sync source) ever wrote
  `BLOOD_PRESSURE_DIA` rows without paired `BLOOD_PRESSURE_SYS` rows,
  the BP achievements would not become earnable. The comment at
  lines 26-28 of the test file explains the design choice ("avoid
  double-counting") but doesn't justify why DIA-only data invalidates
  the user from BP achievements.
- **Recommendation**: Either:
  - `bpCount = max(sys, dia)` so DIA-only users still earn, OR
  - Document the assumption "BP measurements always include a SYS
    row" and add a guard that drops DIA-only writes upstream.
    No action probably needed for v1.4.18 — Withings + manual entry
    always pair them — but worth a backlog note.
- **Ship-blocker?**: NO.

### M2 — Hidden hint text is revealed in the unlock toast description

- **Severity**: MEDIUM
- **File**: `src/components/gamification/achievement-unlock-notifier.tsx:120-129`
- **Issue**: When a hidden achievement unlocks, the toast description
  is `${t(achievement.titleKey)} — ${t(achievement.descriptionKey)}`
  which combines the **real** title and description (e.g.
  `"Night owl — Logged an entry between 02:00 and 04:00 in the morning."`).
  This is correct _for the toast itself_ (the unlock IS the moment
  to reveal the surprise). However, after the toast dismisses, the
  notifier persists `seenIdsRef` so the hidden ID is no longer
  treated as new. If the user switched their device clock back, or
  cleared localStorage, the toast would re-fire — but that's an
  acceptable edge case.
- **Recommendation**: No action needed. Behaviour is correct; flagging
  here only because the brief asked the reviewer to look for hidden-
  hint leakage. The unlock-toast reveal is by design.
- **Ship-blocker?**: NO.

### M3 — `/admin/api-tokens` mobile spec covers AdminShell but not SettingsShell

- **Severity**: MEDIUM (parity)
- **File**: `e2e/admin-api-tokens-mobile.spec.ts`
- **Issue**: A2 fixed the painted-scrollbar in BOTH `AdminShell` and
  `SettingsShell` (same `no-scrollbar` utility). The Playwright
  e2e regression guard at `e2e/admin-api-tokens-mobile.spec.ts` only
  asserts the AdminShell path. SettingsShell has unit-level
  coverage in `src/components/settings/__tests__/settings-shell.test.tsx`
  (14 lines added) which checks the className. If `globals.css` ever
  removes the `.no-scrollbar` utility, the unit test still passes
  (it asserts the className, not the rendered scrollbar).
- **Recommendation**: Add a 5-line Playwright spec hitting
  `/settings/profile` at Pixel-5 viewport asserting no horizontal
  scroll. Mirror the AdminShell spec exactly.
- **Ship-blocker?**: NO.

### M4 — `chart-overlay-prefs` route doesn't annotate the previous values for audit trail

- **Severity**: LOW
- **File**: `src/app/api/dashboard/chart-overlay-prefs/route.ts:81-92`
- **Issue**: The `annotate()` call at the end captures the new flags
  but not the previous ones, so a session log can't reconstruct the
  full toggle history. Compare to `applyProfileUpdate` in
  `src/lib/auth/profile-update.ts:89-94` which captures `from` /
  `to` for the locale change.
- **Recommendation**: If audit forensics matters for chart overlay
  prefs (probably not — Marc said this is a UX prefs blob not an
  analytical attribute), capture both old and new flag sets in the
  annotation. Otherwise drop this finding.
- **Ship-blocker?**: NO.

### M5 — `health-chart.tsx` no longer renders the personal-baseline ReferenceLine — confirm via grep

- **Severity**: LOW (verification — the test already enforces this)
- **File**: `src/components/charts/health-chart.tsx`,
  `src/components/charts/__tests__/health-chart-overlay-defaults.test.tsx`
- **Issue**: The default-overlay test reads the source file and
  asserts no unconditional baseline ReferenceLine. This is a brittle
  source-string assertion (`readFileSync` + regex) that will break
  if the file is reformatted or split. It's a reasonable
  short-term guard, but it's not the same as testing the rendered
  output.
- **Recommendation**: Replace with an SSR render assertion: render
  `<HealthChart>` with default props, assert no element has
  `data-slot="chart-personal-baseline-line"` (or whatever the
  ReferenceLine's identity ends up being). Mirror the medication
  chart's overlay-toggle test pattern.
- **Ship-blocker?**: NO.

### L1 — `parseDayKey` redundantly sets UTC hours after constructor

- **Severity**: LOW
- **File**: `src/lib/gamification/expansion-metrics.ts:230-232` (used
  inside `getEngagementMetrics`)
- **Issue**: `parseDayKey` constructs the date with
  `new Date(Date.UTC(year, month - 1, day, 12, 0, 0))` (already
  noon UTC). The next line `cursor.setUTCHours(12, 0, 0, 0)` is a
  no-op.
- **Recommendation**: Drop the redundant line.
- **Ship-blocker?**: NO.

### L2 — `de.json` / `en.json` symmetry not asserted for the v1.4.18 expansion strings

- **Severity**: LOW
- **File**: `messages/de.json`, `messages/en.json`,
  `src/lib/__tests__/i18n*.test.ts` (per CLAUDE.md the symmetry
  guard exists)
- **Issue**: Couldn't verify in this review whether the existing
  i18n parity test enumerates the 22 new keys (mood × 3 + measurement
  counts × 7 + engagement × 4 + hidden × 6 + hiddenCard placeholder
  - hiddenUnlockToast + 2 category labels). The expansion adds ~30+
    new keys; if the parity test is data-driven (read both files,
    assert keys match), this is automatic. If it's hand-rolled, some
    may have slipped.
- **Recommendation**: Quick sanity run of `pnpm test
src/lib/__tests__/i18n*` to confirm 0 failures. Already in CI most
  likely.
- **Ship-blocker?**: NO.

## SUMMARY

- 1 CRITICAL (C1 — hidden achievement trigger leakage via API response)
- 5 HIGH (H1 race, H2 hook subscription, H3 bug-buddy metric leak [subsumed by C1], H4 mood-window semantics, H5 unbounded count growth)
- 7 MED/LOW (M1-M5, L1-L2)

Ship-blocker count: **1** (C1).

Recommended action before v1.4.18 release: scrub `metric` /
`titleKey` / `descriptionKey` / `target` / `current` /
`progressPercent` / `points` from hidden+locked entries in the API
response body. Add a route-level test that asserts hidden trigger
strings are not present in the response while the achievement is
locked, and ARE present once unlocked. Item H3 is auto-resolved by
the C1 fix.

The H1 race condition is real but masked in single-user usage; safe
to defer with a backlog entry. H2-H5 are correctness / hygiene
issues; defer to v1.4.19 absent regression reports. M/L items are
follow-on hygiene work.

Strong work overall — A1 BD-tile fix is clean and well-tested
(`computeBpInTargetWindows` reuses the v1.4.16 ceiling predicate
correctly with explicit null-handling for sparse data), A2 painted-
scrollbar fix correctly identifies that the same defect lives in
both shells and uses a single utility class to fix both, A3 chart
revert is thorough (all three reversions land + the toggle UI
persists per-chart cleanly), and B1 achievements expansion has
strong unit + integration test coverage for the visible cases. The
discovery filter design is correct. The remaining work is the wire-
shape hardening for the hidden category and the race-condition
guard for concurrent overlay toggles.
