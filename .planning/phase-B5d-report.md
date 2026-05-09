# Phase B5d — Confidence score per recommendation (v1.4.16)

Completed 2026-05-10 ~01:40 CEST.

## What landed

Six atomic commits on origin/main (worktree:
`agent/b5d-confidence`, clean rebase + push to `main`), each TDD-first
(failing test, then fix). All verification gates green:
`pnpm test` 1457/1457, `pnpm test:integration` 59/59,
`pnpm typecheck` 0 errors, `pnpm lint` 12 pre-existing warnings.

| # | Commit | What it ships |
|---|--------|---------------|
| 1 | `0cb0373 feat(ai): deterministic confidence-score computation per recommendation` | New `aiRecommendationSchema.confidence: z.number().int().min(0).max(100).optional()`. Mirror field on the UI-side `insightRecommendationSchema`. NEW `src/lib/ai/confidence.ts` — pure `computeConfidence({ n, recencyDays, deviationStdRatio })` returning 0..100. Score: log-saturating n curve (cap 40, n<3 hard-cap 5*n) + linear recency decay (30 at <2d → 0 at 30d) + signal contribution (30 at \|z\|≥1.5, scaled to 0; null → neutral 15). 15 tests cover the input matrix per research §2.C plus monotonicity-in-n + integer-in-bounds invariants. |
| 2 | `af21d4d feat(ai): wrapper overrides recommendation confidence with deterministic computation` | `generateInsight()` post-validation step OVERWRITES `rec.confidence` with `computeConfidence()` for every rec. The model's claimed value is discarded. New optional `options.confidenceContext` resolver lets a route layer supply per-rec `ConfidenceInputs` derived from `metricSource.n` + bucket-series freshest bucket + 90-day stdev; default fallback is `{ n: metricSource.n ?? 0, recencyDays: 0, deviationStdRatio: null }` so the override fires regardless. Wide-Event annotation `ai_confidence_override_*` carries per-rec `{id, model, computed}` triples for admin observability. 6 wrapper tests pin: model 99 → server 65 (default fallback), wrapper-fills when absent, resolver path overrides, n<3 hard-cap, missing `metricSource.n` → n=0 floor, resolver receives each rec in payload order. Citation-coverage test relaxed to find call by meta-key (annotate is now called twice). |
| 3 | `7ec1030 feat(insights): ConfidenceMeter component (bars + ring + draft pill below 25)` | NEW `<ConfidenceMeter value={n} variant="bars\|ring">`. Bars variant: 5 bars rising in height (4/6/8/10/12 px) so the "more is more" cue works without color (a11y). Ring variant: 28×28 SVG with stroke-dasharray fill. Color bands: green ≥80, yellow 50-79, orange 25-49; below 25 a red "Draft" pill REPLACES the meter (Apple's quiet-when-unsure affordance per research §2.A). aria-label always announces numeric score in EN/DE. NaN/-1 → 0 (draft); >100 → 100 (high). 5 i18n keys per locale: confidence + confidenceAria + confidenceHigh/Medium/Low/Draft. 17 component tests cover all 5 bands + both variants + EN/DE aria-label + clamp. |
| 4 | `63cfd8e feat(insights): RecommendationCard renders ConfidenceMeter in named slot` | Fills `data-slot="rec-confidence-slot"` with `<ConfidenceMeter value={rec.confidence} />`. Slot stays empty when confidence is undefined (legacy payload). Below 50, expanded rationale card surfaces "Low confidence — based on limited data" caption. Below 25 caption still applies because draft <= low. B5e's feedback-thumbs slot left untouched. Threshold is named const (`LOW_CONFIDENCE_CAPTION_THRESHOLD = 50`). 8 wiring tests. |
| 5 | `d343ab5 test(insights): coverage for confidence computation + meter rendering` | Full-flow integration test: MockAIProvider returns model=99 → wrapper overrides with computed=65 (n=9, recency=0, ratio=null) → InsightAdvisorCard renders the medium/yellow band, NOT high/green. Second case pins n=1 → draft band end-to-end. 2 tests. |
| 6 | `173c3e1 test(insights): rec-card-confidence test plays nice with B5e thumbs` | Cross-agent race fix: B5e wired RecommendationFeedback into the rec card concurrently. My test got the same useAuth + useMutation + tanstack-query SSR mocks the existing `recommendation-card.test.tsx` carries; the "feedback-slot is empty" assertion relaxed to "feedback-slot is still rendered" since B5e legitimately fills it. |

## Cross-agent race notes

B5e ran fully in parallel and pushed 4 commits to origin/main while I
worked. Both rebase rounds were clean — single conflict in each:

- Round 1: `messages/{en,de}.json` keep-both merge (B5e added
  `feedback*` keys; B5d added `confidence*` keys; both belong under
  `insights.recommendation.*`).
- Round 2: `recommendation-card.tsx` keep-both merge (B5e added the
  `RecommendationFeedback` import + `feedbackProps` plumbing; B5d
  added the `ConfidenceMeter` import + `confidence` plumbing; both
  preserved verbatim).

The named-slot architecture from B5c paid off — neither phase had to
touch the other's surface and the merge was mechanical.

The fixup commit (`173c3e1`) was needed because my SSR-rendering tests
for the rec card now indirectly mount RecommendationFeedback (which
calls `useAuth`), so the same mocks the existing rec-card test file
already had needed to be ported into mine. Caught immediately by the
post-rebase test run.

## Open follow-ups for v1.4.17

1. **Bucket-series-aware resolver in the route layer**: the wrapper
   has the optional `confidenceContext` parameter wired but
   `/api/insights/generate` still uses the default fallback. Wiring
   it requires plumbing `bucketSeries()` for each metric the rec
   cites and computing a 90-day stdev per type. Worth its own phase
   since it touches the route surface and the bucket-series module.
2. **Schema flip from `.optional()` to required**: once the route
   layer always supplies confidence, we can ratchet the schema to
   reject payloads without it. v1.4.17 work after migrations.
3. **Feedback-tuned formula**: research §2.C calibration was
   pre-feedback. With B5e now persisting thumbs-up/down, v1.4.17 can
   fit the n / recency / signal weights to user feedback rates per
   `(severity × confidence_band)`.

## What B5e + future phases inherit

- The strict schema carries an integer-bounded `confidence` field
  that round-trips through the cached payload; `RecommendationFeedback`
  in B5e already captures `recommendationConfidence` on the row (per
  research §5.2 forward-compat note) — the v1.4.17 ratchet has the
  data it needs.
- The `<ConfidenceMeter>` is locale-aware and pure, so a future
  Comparison-Views (B8) "delta callout" surface can reuse it for
  confidence-on-comparison-overlays without modification.
- Wide-Event annotation `ai_confidence_override_pairs` gives the
  admin AI-quality dashboard a model-vs-deterministic drift series
  per generation. Charting that drift by provider type closes a gap
  the B5b multi-provider work opened.
