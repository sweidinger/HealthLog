# Phase B5c — Per-recommendation explainability (v1.4.16)

Completed 2026-05-10 ~01:17 CEST.

## What landed

Eight atomic commits on origin/main (worktree: `agent/b5c-explainability`,
clean rebase + push to `main`), each TDD-first (failing test, then fix):

| #   | Commit                                                                                             | What it ships                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `8a438a0 feat(ai): schema requires rationale (window + comparedTo + deviation) per recommendation` | New `aiRecommendationRationaleSchema` + mandatory `rationale` field on `aiRecommendationSchema`. Empty `comparedTo` / `deviation` rejected; `dataWindow` enum locked to the 4-window vocabulary. New `findRecommendationsMissingRationale()` for legacy-payload detection. 10 unit tests + 5 fixture-touch updates across `generate-insight.test.ts`, `reference-id-schema.test.ts`, `citation-enforcement.test.ts`, `citation-coverage-logging.test.ts`.                                                                                                                                                                                                                                                                                                                               |
| 2   | `c39a527 feat(ai): system prompt requires rationale per recommendation`                            | EN+DE prompt advertises the new field shape AND a fifth GROUND RULE mandating rationale on every rec. `rationale.dataWindow MUST equal metricSource.timeRange` is enforced at prompt-time so the mini-chart pinning is bracket-mismatch-free. PROMPT_VERSION stays at 4.16.0 (B5a already bumped). 6 prompt-assertion tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 3   | `13f1ae5 feat(ai): corrective retry covers missing rationale fields`                               | The wrapper's `buildRetryCorrectionMessage()` now lists the three rationale fields explicitly so a first-attempt response without rationale gets a targeted reprompt. Three new `ai_rationale_*` Wide-Event keys land alongside the existing citation-coverage annotations so the admin AI dashboard can chart rationale-coverage per generation. 4 unit tests.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 4   | `c8b30c1 feat(ai): legacy insight payload detection with regenerate CTA`                           | New `isLegacyInsightPayload()` helper + route wiring: `/api/insights/generate` returns `legacyPayload: true` on cache-hit when the cached blob predates B5c rationale. UI shows a one-time "Insights updated — regenerate for new explainability features" CTA pointing at the regenerate button. User-initiated only; no auto-regen on cache-hit (would burn rate-limit tokens silently). 7 unit tests.                                                                                                                                                                                                                                                                                                                                                                                |
| 5   | `7f54c0c feat(charts): mini-mode + windowOverride prop for embedded rationale charts`              | HealthChart gains `mini` (drops range tabs + toggle row, h-[140px]) and `windowOverride` (pins to a rationale enum value). New pure helper `resolveMiniRangePoints()` (`mini-window.ts`) maps the rationale enum onto the existing per-points TIME_RANGES_KEYS. 7 unit tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 6   | `680f84c feat(charts): mood chart mini-mode + windowOverride`                                      | MoodChart mirrors the same `mini` + `windowOverride` contract so mood-typed recommendations get a dedicated emoji-glyph mini-chart.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 7   | `10a67ff feat(insights): RecommendationCard with expandable rationale + mini-chart of data window` | New `<RecommendationCard>` subcomponent with severity badge, default-collapsed chevron, animated 200ms expand reveal, 3-row `<RationaleCard>` (Window / Compared to / Deviation), pinned mini-chart (HealthChart for measurement metrics, MoodChart for mood-keyed recs), citation footnote, and named slots for B5d (`data-slot="rec-confidence-slot"`) and B5e (`data-slot="rec-feedback-slot"`). InsightAdvisorCard refactored to consume it; `legacyPayload` prop surfaces the regenerate CTA banner. InsightRecommendation type widens to optionally carry rationale + metricSource + severity + id. EN+DE i18n keys: `rationale`, `rationaleWindow`, `rationaleComparedTo`, `rationaleDeviation`, `rationaleExpand`, `rationaleCollapse`, `legacyPayloadCta`. 11 component tests. |
| 8   | `fed2e7e test(insights): coverage for RecommendationCard expand + rationale rendering`             | Full-flow integration test: MockAIProvider → `generateInsight()` → InsightAdvisorCard → SSR markup assertion. Second case pins the legacyPayload CTA path with a string-only recommendations[] payload. 2 tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Verification

- `pnpm test` — 1361/1361 unit tests pass (was 1324 → +37 net for B5c: 10 schema + 6 prompt + 4 wrapper + 7 legacy-payload + 7 chart-mini + 11 rec-card + 2 integration − fixture updates).
- `pnpm test:integration` — 53/53 pass (no regression).
- `pnpm typecheck` — 0 errors.
- `pnpm lint` — 12 pre-existing warnings / 0 errors.

## Layout slots reserved for B5d + B5e

The rec card layout follows research §5.1 (one component spec, named
slots so later phases plug in without touching this file):

```
[severity-badge] rec-text                   [confidence-slot] [chevron▼]
 (expanded:)
   ─ rationale rows (Window / Compared to / Deviation)
   ─ mini-chart pinned to rec.rationale.dataWindow
   ─ citation footnote (B5a) when referenceId resolves
   [feedback-slot]
```

- `data-slot="rec-confidence-slot"` (collapsed row, right-of-text) →
  B5d `<ConfidenceMeter>` plugs in here. Span placeholder is
  always rendered so tests can pin the position.
- `data-slot="rec-feedback-slot"` (inside expanded rationale card,
  bottom) → B5e `<RecommendationFeedback>` plugs in.

## Charts: missing wrappers (deferred)

The brief asked for `mini` mode on **BP, weight, pulse, mood,
medication**. BP / weight / pulse all share the single `HealthChart`
wrapper — one commit covers them. Mood got its own commit. The
medication-compliance chart wasn't touched: the rec-card metric
mapping treats `medications.compliance30` as `null` chart route
(returns no embedded chart) for now, since the compliance heatmap is
visually heavy and doesn't shrink cleanly to 140px. That's a v1.4.17
follow-up if rec authors actually emit compliance-keyed
recommendations.

## E2E (Playwright) — not added; rationale below

The brief listed an aspirational e2e: "on /insights, expand a
recommendation → assert rationale rows visible, mini-chart canvas
rendered." Investigation: `/insights` does NOT consume
`<InsightAdvisorCard>` in the production tree — it renders
`InsightStatusCard` per-section with a plain `text` field. Both
`<InsightAdvisorCard>` and `<InsightsCard>` are currently unused in
the live app (zero non-test imports). The headless-rendered
integration test `recommendation-card-integration.test.tsx` exercises
the same surface against a MockAIProvider end-to-end.

When a future phase wires `<InsightAdvisorCard>` onto a live page
(likely as part of the Wave-B B1 broader insights surface
visualisation, or a v1.4.17 dashboard refresh), an e2e can drop in
and reuse the storage-state pattern from `e2e/insights-generate.spec.ts`.

## Cross-agent race notes

Worktree-isolated under `agent/b5c-explainability` so the parallel B2
worker on the primary checkout couldn't bleed in. The integration
worktree (`/Users/marc/Projects/HealthLog-b5c`) carries its own
`pnpm install` + Prisma client; commits ride into origin/main via
`git push origin agent/b5c-explainability:main` after a clean rebase.
Zero collisions this round.

## What B5d + B5e inherit

- The rec card has named slot positions ready (`rec-confidence-slot`
  collapsed; `rec-feedback-slot` expanded). Plugging in is a one-line
  edit in `recommendation-card.tsx`.
- The strict `aiRecommendationSchema` carries `rationale` mandatory.
  B5d's `confidence` field can ride alongside (already `.optional()`
  per research §2 — flip to required after B5d ships).
- `findRecommendationsMissingRationale()` + the `ai_rationale_*` Wide-
  Event annotations let the admin AI quality dashboard chart
  legacy-payload migration alongside citation-coverage and (B5d/B5e
  later) confidence + feedback rates.
- `legacyPayload` flag on `/api/insights/generate` response is the
  same shape B5d / B5e can extend (additive flags rather than a
  breaking change).
