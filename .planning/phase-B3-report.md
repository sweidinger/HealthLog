# Phase B3 — Correlation discovery + Trends row with AI annotations (v1.4.20)

Three pre-defined hypothesis cards (BP × medication compliance, mood ×
resting pulse, weight × weekday) and an AI-annotated Trends row land
on `/insights` between the Daily Briefing and the Advisor card.
Six atomic commits on `origin/develop`.

## Approach

Scope discipline locked in early: v1.4.20 ships **3 pre-defined
hypotheses**, NOT general automated correlation discovery. Full
metric-pair scan with FDR control is v1.5/v1.6 work.

Quality bar non-negotiable per the strategic plan:

- `n >= 14` paired data points
- `p < 0.05`

Below the bar each card paints an `<EmptyState>` rather than a
near-zero scatter that would imply a pattern that isn't there.

## Deliverables

1. **`src/lib/insights/correlations.ts`** — pure runners (`pearson`,
   `weekdayAnova`, `correlateBpCompliance`, `correlateMoodPulse`,
   `correlateWeightWeekday`). 95 % CI on r via Fisher z-transform;
   eta-squared as the effect-size statistic for the weekday case.
   Two-sided p-values from inline Wilson-Hilferty (F) +
   Abramowitz-Stegun (z) approximations — no new dependencies.
   16 unit tests pin positive / negative / no-correlation / under-n /
   non-significant / no-variance branches and the Monday-spike
   weekday flag.

2. **`aiInsightResponseSchema` + prompt rule 9** — added a nullable +
   optional `trendAnnotations: { bp?, weight?, mood? }` block (each
   string ≤ 200 chars). PROMPT_VERSION 4.20.0 → 4.20.1. EN + DE
   ground rule 9 explicitly bans causal language and caps the
   sentence length. 13 schema + prompt-shape tests.

3. **`<TrendAnnotation>` + `<TrendsRow>`** — pure presentational. Row
   is 1-column on `<md`, 3-up on `>=md`. Annotations show a
   `Sparkles` icon + the AI sentence + an optional confidence chip
   (low / moderate / high). Empty state hints at the gap without
   breaking the row's visual rhythm. 15 component tests.

4. **`<CorrelationCard>` + `<CorrelationRow>`** — card has tone-coloured
   left bar, scatter sparkline (deferred-bundled via the existing
   `<ScatterCorrelationChart>` wrapper), confidence chip, source-chip
   ("based on N paired readings · last 30 days"), interpretation
   prose, disabled "Try a 7-day experiment" CTA with `title="Coming
soon"`. Row mounts the three cards in 2-up grid on `>=md` and
   single column on `<md`; the correlation-disclaimer footer
   ("Patterns are observational, not causal — talk to your doctor if
   BP runs high.") sits below the row once. 13 component tests.

5. **`/api/analytics` + `/insights` page wiring** — server-side
   computes the three hypotheses on the trailing 30-day window and
   surfaces `correlations: {bpCompliance, moodPulse, weightWeekday}`
   on the response. `<CorrelationRow>` mounts above `<TrendsRow>`
   between Daily Briefing and the Advisor card. The advisor hook
   lifts `trendAnnotations` from the cached AI payload through
   `trendAnnotationsSchema.safeParse` so legacy 4.20.0 payloads
   resolve to null and trigger the per-metric empty hint. 10
   source-scan tests pin imports, JSX mounts, and the wide-event
   annotation.

## Tests

- vitest unit suite: 1833 → 1907 (+74 net)
- integration suite: 67/67, no regression
- typecheck + lint clean (no new warnings introduced)

## Synthetic-data spot checks

- `correlateBpCompliance({...})` for the canonical 20-row strong-fit
  fixture (compliance 50→97.5 %, systolic 150→120) →
  `status: "ok"`, `statistic ≈ -1.0` (perfect linear), `pValue < 0.001`,
  confidence band label `"high"`, n = 20.
- `correlateMoodPulse({...})` for the 20-row low-mood/high-pulse
  fixture → `status: "ok"`, negative `statistic`, p well under 0.05.
- `correlateWeightWeekday({...})` for the 4-week Monday-spike fixture
  (Monday ≈ 84 kg, every other day ≈ 80 kg) → `status: "ok"`,
  `outlierIndex = 0`, eta² > 0.14 (Cohen "large"), interpretation
  flags Monday with the conservative "a pattern worth watching"
  phrasing.

## Did NOT ship

- **Real "Try a 7-day experiment" scheduling.** The CTA is intentionally
  disabled in v1.4.20 with the Coming-soon tooltip; live scheduling is
  a v1.5 surface.
- **Storyboard / 90-day BP timeline annotations.** Still B4 work.
- **Weekly Report `/insights/report/[week]` route.** Still B4 work.

## Decisions that may want maintainer review

- **Confidence-band-from-CI mapping.** `width(CI) <= 0.4` → "high",
  `<= 0.8` → "moderate", else "low". The thresholds are heuristic; if
  the user-facing chip ends up too aggressive (e.g. "high" pops on
  noisy small-n results) we can tighten to 0.3 / 0.6.
- **Eta-squared confidence band for weekday.** No closed-form CI on
  eta² without a non-central F distribution we don't carry. Mapped
  via Cohen conventions (`eta² >= 0.14` → "high", `>= 0.06` →
  "moderate") with an n-driven nudge. If marathon QA flags this as
  too lenient we can drop the nudge or surface "n-low" as its own
  pseudo-band.
- **Interpretation phrasing.** Locked to a small set of conservative
  templates inside the runners — never reaches the AI provider —
  so the EN strings live in `correlations.ts` rather than i18n. If
  Marc wants German-locale interpretations, we'd need to localise
  these or move them through `t()`.
- **Trend-annotation surface gating.** The annotation block is
  optional — if the model omits a metric, the empty hint surfaces
  ("Awaiting more data to annotate this trend"). For the legacy
  (4.20.0) cached payload everyone sees the empty hint until they
  click Regenerate. Opt: we could auto-regenerate once on first
  page-mount post-deploy; opted not to so users keep their existing
  cache TTL.
- **Inline ANOVA p-value approximation.** Wilson-Hilferty for the
  F-distribution is good enough for the surfacing decision, but a
  reviewer should sanity-check against a small-df edge case if Marc
  is worried about precision near `p ≈ 0.05`.

## Files added / modified

- `src/lib/insights/correlations.ts` (+
  `__tests__/correlations.test.ts`)
- `src/lib/ai/schema.ts` — `trendAnnotationsSchema` + integration
- `src/lib/ai/prompts/insight-generator.ts` — PROMPT_VERSION 4.20.1
  - GROUND RULE 9 (EN + DE) + JSON shape entry
- `src/lib/ai/__tests__/trend-annotations-schema.test.ts`
- `src/components/insights/trend-annotation.tsx` +
  `__tests__/trend-annotation.test.tsx`
- `src/components/insights/trends-row.tsx` +
  `__tests__/trends-row.test.tsx`
- `src/components/insights/correlation-card.tsx` +
  `__tests__/correlation-card.test.tsx`
- `src/components/insights/correlation-row.tsx` +
  `__tests__/correlation-row.test.tsx`
- `src/app/api/analytics/route.ts` — three runners + Berlin-day
  bucketing helpers
- `src/app/insights/page.tsx` — mounts CorrelationRow + TrendsRow
- `src/components/insights/use-insights-advisor.ts` — lifts
  trendAnnotations from the cached payload
- `src/app/__tests__/insights-b3-wiring.test.ts`
- `messages/en.json`, `messages/de.json` —
  `insights.{trendsRow,trendAnnotation,correlationRow}` keys
