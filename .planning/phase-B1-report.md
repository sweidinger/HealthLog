# Phase B1 — Achievements expansion (v1.4.18)

Status: complete · 7 commits pushed to `origin/main` ·
`75c74f1...e75ea75`.

## What landed

Roster grew from **38 → 59** (+21 achievements):

- **mood (4)** — `mood-first`, `mood-streak-7`, `mood-streak-30`,
  `mood-up-7` (7-day mean improvement vs prior week, personal
  baseline only)
- **vitals counts (7)** — first/50/200 weigh-ins, first/50/200 BP
  readings, first pulse log
- **engagement (4)** — `consistent-month` (≥25 distinct days in a
  Berlin-local calendar month), `entry-streak-7` / `-30` (any-data
  day streak), `weekend-warrior` (4 consecutive Sat+Sun pairs)
- **hidden Easter-eggs (6)** — `night-owl` (02:00–04:00 Berlin),
  `early-bird` (04:00–06:00), `leap-day` (Feb 29), `doctor-pdf`
  (first PDF export), `locale-flip` (first language change),
  `bug-buddy` (≥5 bug reports)

Hidden achievements render as opaque "Hidden achievement"
placeholders in the locked state — the real title, description,
metric and target are *never* written to the DOM, so a curious user
cannot inspect the page source to learn the trigger. Once unlocked,
the strings reveal themselves on the same card; the unlock toast
gets a longer (8 s) `<Sparkles>` celebration with the localized
"You unlocked a hidden achievement!" headline.

A new `applyDiscoveryFilter` ensures public locked badges only
render when the user has the underlying data (a mood-streak badge
stays out of the list until they log their first mood). Hidden
Easter-eggs ignore the filter; already-unlocked badges always render
so deleting data doesn't make completed achievements disappear.

## Commit walk

1. `docs(achievements): v1.4.18 expansion research with 20+
   proposed achievements` — research at
   `.planning/v1418-achievements-research.md`.
2. `feat(achievements): definitions for v1.4.18 expanded set +
   hidden Easter-eggs` — types, `ACHIEVEMENT_DEFINITIONS` list,
   EN+DE strings, page mood/hidden category labels,
   `CATEGORY_LABEL_KEY` exhaustiveness.
3. `feat(achievements): evaluators for new achievements (with
   discovery rules)` — wires `buildExpansionMetricValues` +
   `applyDiscoveryFilter` into the route, fetches `MoodEntry`,
   recomputes summary from the visible set.
4. `feat(achievements): page renders unlocked + locked + hidden
   achievements with progress` — opaque hidden card, new lucide
   icons, page tests for the four card states + locale-localized
   hidden heading.
5. `feat(dashboard): recent-achievements card celebrates hidden
   unlocks` — `<Sparkles>` toast variant for `isHidden: true`.
6. `test(achievements): coverage for evaluators + UI states` —
   13 unit assertions against `expansion-metrics.ts`, 3 integration
   tests round-tripping prisma rows, e2e describe-block exercising
   all four card states with leak-resistance asserts.
7. `feat(achievements): worker re-evaluates new + hidden
   achievements on data change` — fixed two trigger bugs (the
   doctor-PDF action used a non-existent name; locale-flip now
   emits its own `settings.locale.update` audit row when the locale
   actually changes).

## Verification

- `pnpm test`: 1598 / 1598 passing
- `pnpm test:integration`: 62 / 62 passing
- `pnpm typecheck`: 0 errors
- `pnpm lint`: 0 errors / 13 pre-existing warnings (unchanged)
- E2E: spec adds 1 new test inside an existing describe-block; the
  spec file has been compiled by the playwright TS pipeline (run by
  the existing `pnpm e2e` script) but not exercised against a
  running dev server here.

## Notable decisions

- **Hidden = unknown to the DOM.** The page renders an early-return
  placeholder for `isHidden && !unlocked` so the real strings never
  reach the rendered HTML; the test suite asserts the absence of
  the trigger metric name and English title.
- **Discovery-filter lives in the route, not the page.** The route
  recomputes `summary` from the visible set so the headline counters
  match the rendered list exactly. The page layer trusts the API
  response and renders what it gets.
- **Locale-flip needed a real audit signal.** The catch-all
  `profile.update` row didn't disambiguate which field changed.
  `applyProfileUpdate` now emits a separate `settings.locale.update`
  audit row when (and only when) the locale value actually changes,
  with from/to values in the details payload.
- **Discovery does not gate the iOS format.** The iOS format flag
  consumes the same filtered list — apps will see exactly what the
  web sees, including hidden cards as opaque placeholders. iOS
  clients can render their own "?" affordance from `isHidden: true`
  + `unlocked: false`.

## Out of scope / followups

- The integration test had to skip the full HTTP route because of
  pre-existing `medication_schedules.days_of_week` migration drift
  in the testcontainer. Tracked separately; my unit + helper-level
  integration coverage is sufficient for B1.
- Hidden achievement set is intentionally small (6 vs. brief's
  5–8 ceiling). I'd rather ship 6 polished triggers than chase
  numbers; if Marc wants more, follow-on adds are trivial because
  the definition + evaluator path is now well-paved.
