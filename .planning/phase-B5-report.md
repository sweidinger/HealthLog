# Phase B5 — Personal AI Coach Health Score (v1.4.20)

Status: complete
Date: 2026-05-10
Branch: `develop`

## Scope

Final B-phase before multi-agent QA. Closes the Insights redesign
hero band by mounting a server-deterministic Personal Health Score
panel on the right side of the hero. Strategic plan:
`.planning/phase-D-v1419-product-lead-review.md` § "Phase B5 —
Personal AI Coach Health Score".

## Commits on `origin/develop`

1. `73d2188` feat(insights): personal Health Score formula library
2. `236b498` feat(api): emit Health Score from /api/analytics
3. `067bf31` feat(insights): Health Score panel component
4. `91ad5ec` feat(insights): mount Health Score panel in hero strip
5. (this commit) docs(planning): mark Wave-B B5 complete + report

## What shipped

### 1 · `health-score.ts` library + tests (commit 1)

Pure pure pure. Server-deterministic composite of four components.

```
score = round(
  0.30 * bpInTargetRate
+ 0.20 * weightTrendAlignment
+ 0.20 * moodStability
+ 0.30 * complianceRate
)
```

When a sub-component is null (insufficient data), the remaining
weights scale proportionally so they still sum to 100. Bands:
green ≥ 75, yellow 50..74, red < 50.

Pure helpers exported alongside the composite for downstream tests:

- `linearRegressionSlope(points)` — least-squares slope, units / day
- `coefficientOfVariation(values)` — `stdev / |mean|`
- `weightTrendAlignment(series, target)` — closing-gap-toward-band
  metric with a tanh-saturation curve (0.05 kg/day saturates to
  ~75 % alignment so noisy readings don't cliff the score)
- `moodStability(entries)` — `100 - CV*100`, requires ≥5 entries
- `complianceRate(values)` — rounded mean
- `defaultWeightTargetFromHeight(heightCm)` — BMI-22 fallback (since
  `User.weightTargetKg` doesn't exist on the schema yet)

29 unit tests under `src/lib/analytics/__tests__/health-score.test.ts`
cover strong / mixed / poor scenarios, every null-redistribution
shape, and determinism (same input → same output).

### 2 · `/api/analytics` returns Health Score (commit 2)

The route gains a `healthScore: { score, band, components, delta }
| null` field. The compute reuses the already-computed
`bpInTargetPct` headline for the BP component and runs three fresh
queries scoped to the last 37 days for weight, mood, and medication
intake events (so both the current 30-day window and the 7-day-
shifted snapshot for the delta share one round-trip).

The previous-week BP rate reuses the all-time figure (it's a slow-
moving aggregate; rewinding it cheaply isn't possible without a
full historical re-pair). The delta therefore primarily reflects
week-over-week movement in weight / mood / compliance — the
components that actually move on a weekly cadence.

The wide-event annotation carries `healthScore.score` + `band` +
`delta` so admin-app-logs can attribute coverage without DB queries.

The route avoids `include: { schedules: true }` — the Prisma client
expects a `medication_schedules.days_of_week` column that exists in
schema.prisma but never landed in a migration. We `select` only the
columns that are actually deployed (`windowStart`, `windowEnd`) so
the route survives the schema-drift the rest of the app worked
around. Captured as a flagged-uncertain item below.

3 integration tests under
`tests/integration/analytics-health-score.test.ts` seed three
synthetic-data shapes against the postgres testcontainer:

- strong-positive → green band (≥ 75)
- empty user → null healthScore
- compliance-only → bp / weight / mood null, compliance weight 1.0

### 3 · `<HealthScoreCard>` component (commit 3)

Pure presentational right-side hero panel. Dracula band tokens
(`--dracula-green / orange / red`) carry WCAG AA contrast against
`bg-card/65`. Rendered slots:

- `health-score-card` (wrapper, with `data-band` attr)
- `health-score-card-label` (eyebrow caption)
- `health-score-card-number` (band-coloured tabular-nums headline)
- `health-score-card-progress` (band-tinted progress bar with
  `role="progressbar"` + ARIA values for screen readers)
- `health-score-card-delta` + optional `-delta-chip` (arrow + chip)
- `health-score-card-components` (4 component rows with sub-bars)
- `health-score-card-disclaimer` ("Indicative — not a clinical
  assessment.")
- `health-score-card-ask-coach` (mounted only when `onAskCoach` is
  supplied; passes "Why is my health score X out of 100?" prefill)

i18n keys under `insights.healthScore.*` in en.json + de.json.

17 SSR tests pin band colours, delta-arrow shapes, the null-
component em-dash fallback, the German locale, the score-aware
prefill argument, the progressbar role + ARIA values, and the
score-clamp at 0..100 % bar width.

### 4 · `<HeroStrip>` wiring (commit 4)

The hero strip's right side, empty by design since B1, paints the
`<HealthScoreCard>` whenever `analytics?.healthScore` is non-null.
Layout flips from `flex-col` to `flex-row` on `lg+` so the panel
sits beside the title block on desktop and stacks below on mobile.

The `onAskCoach` prop signature picks up an optional `prefill`
argument. The action-row "Ask the coach" button passes nothing
(drawer opens blank); the score panel passes
"Why is my health score X out of 100?". Both share the same
drawer state so the user only ever sees one drawer instance.

5 new hero-strip cases pin the score panel slot, the `lg:flex-row`
layout switch, and the conditional ask-coach button mounting.

### 5 · STATE.md tick + reports (commit 5)

- `STATE.md` B5 ticked complete; Wave-B summary section added.
- This file (`phase-B5-report.md`) summarises the wave + flagged-
  uncertain items.

## Verification gates

- `pnpm typecheck` — clean.
- `pnpm lint` — 13 pre-existing warnings (none introduced by B5).
- `pnpm test --run` — 1975 → 2026 tests (+51). Test files 235 → 237.
- `pnpm test:integration` — 78 → 81 tests (+3); a one-off retry
  cleared a flaky external-mock 401/503 in `coach-chat.test.ts`
  unrelated to B5.

## Canonical sample score

For the integration test's strong-positive synthetic shape (BP 90 %,
weight closing toward BMI-22 target, stable high mood, perfect
compliance):

- `score: 95`
- `band: green`
- components: bp=90, weight=100, mood=89, compliance=100

So a curious user can mentally recompute:
`0.30 × 90 + 0.20 × 100 + 0.20 × 89 + 0.30 × 100 = 27 + 20 + 17.8 + 30
≈ 95`. Matches.

## Memory-care

- `feedback_marc_voice_english.md` — every commit + report + UI
  string in Marc's voice; no maintainer-name in code.
- `feedback_settings_no_split.md` — Health Score is computed on the
  server and surfaced in one place (the hero panel), not split
  across surfaces.
- `feedback_charts_visual_identity.md` — no chart visual changes;
  the score panel is a discrete card not a chart re-style.
- `feedback_research_before_complex_features.md` — the formula
  followed the strategic-plan spec verbatim. The four-component
  weighted blend matches the artboard's intent. No silent
  reinterpretation; the plan-vs-implementation diff is the formula
  + bands + null-redistribution rules, all defensible from first
  principles.

## Flagged-uncertain items (maintainer review)

1. **Schema drift on `medication_schedules.days_of_week`.** The
   Prisma schema declares the column but no migration applies it.
   The B5 route worked around it with an explicit `select` clause.
   The drift exists across the codebase — `src/app/api/insights/
   comprehensive/route.ts` queries via `include: { schedules: true
   }` and would also fail against a fresh DB. Suggest a v1.4.21
   hygiene PR that either deploys the missing column or removes it
   from schema.prisma.
2. **Previous-week BP rate.** The current implementation reuses the
   all-time figure for the delta computation (described above).
   This is honest about what's measurable but means a user who
   suddenly turns "in-target" for a week won't see a score bump
   from the BP component until the all-time figure follows.
   Acceptable for v1.4.20; v1.5 could persist last-week's score on
   the `User` row to make the delta truly week-on-week.
3. **`User.weightTargetKg` missing.** The plan called for using a
   stored weight target if set, falling back to BMI-22 midpoint.
   The schema doesn't have the field, so we always use the BMI-22
   fallback. The library exposes `defaultWeightTargetFromHeight()`
   so a future schema migration can plug in the user-set target
   trivially.
4. **`MoodEntry.source` enum mismatch.** The integration test
   initially used `source: "MANUAL"` (not in the enum); fixed to
   `WEB`. Worth pinning this in a v1.4.21 source-comment sweep so
   the next test author finds the canonical values.

## Out of scope / deferred

- Persisted last-week score for honest week-on-week deltas (see
  flagged item 2).
- `User.weightTargetKg` schema migration (see flagged item 3) —
  user-set targets unlock the "advanced settings" item from the
  artboard.
- Aggregator integration (the v1.4.16 B5e cross-user feedback loop)
  for the score → that's strategic plan § D.3, deferred to v1.4.21
  per the handoff.

## UX decisions worth flagging for review

1. **Score panel placement** sits right of the hero title on `lg+`,
   stacks below on `<lg`. Width fixed at 220 px on desktop so the
   number reads at a glance without competing with the greeting.
2. **Disclaimer copy.** "Indicative — not a clinical assessment."
   Short, direct, no hedging that turns into noise on every
   refresh. Mirrors the existing AI Coach drawer's "Coach replies
   are generated. Clinical decisions belong with your doctor."
3. **No green chip for delta = 0.** The chip ("+5") only appears
   when the delta is strictly positive — a flat week shouldn't
   read as "improvement". A negative delta is captured in the
   `vs last week` line below the bar (with a red down-arrow), no
   chip.
4. **Component sub-bars share the band colour** rather than each
   sub-component being independently band-coloured. Reading guide:
   the panel is one number, the rows are evidence for it; mixed
   colours would suggest a second-level rating that doesn't exist.
