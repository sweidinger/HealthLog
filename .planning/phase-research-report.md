# v1.4.16 ecosystem-research dispatch — summary

Date: 2026-05-09
Agent: ecosystem-research + STATE-expand
Full document: `.planning/v1416-research-ai-recommendations.md`

## What ran

1. STATE.md elevation — replaced the single `B5 — AI hallucination-
hardening v2` bucket with five first-class items (B5a medical-
   reference grounding, B5b multi-provider redundancy, B5c per-rec
   explainability, B5d confidence score, B5e user-feedback loop) and
   added a new `B8 — Extended comparison views (Vormonat / Vorjahr)`.
   ROADMAP.md mirror-updated.

2. Research document — benchmarked Apple Health Trends, Withings
   Health Mate, and Oura Ring against four features (B5c, B5d, B5e,
   B8). Mapped each onto existing HealthLog architecture
   (`src/lib/ai/*`, `src/lib/insights/bucket-series.ts`, the chart
   wrappers, the `aiInsightResponseSchema`). Drafted file-level
   implementation sketches incl. one new Prisma model
   (`RecommendationFeedback`), zod additions to
   `aiRecommendationSchema`, a deterministic `computeConfidence()`
   helper, a `compareBaseline` chart prop, and the
   cross-feature integration risks. 4 open questions for Marc parked
   at the bottom.

## Top 3 findings

1. **Oura's Contributors model is the gold reference for B5c.** Each
   score expands into per-component cards with band + value + trend.
   HealthLog's strict schema already carries `metricSource`; the
   incremental cost of adding `rationale: { dataWindow, comparedTo,
deviation }` is one zod block + one prompt-version bump. The UI
   slot lives inside an already-planned `<RecommendationCard>` and
   the data source (bucketed daily/monthly history per metric) is
   already produced by `bucket-series.ts`.

2. **Confidence must be server-computed, not LLM-emitted.** Calibrated
   probabilities are not a small-LLM strength, and the v1.4.17
   feedback ratchet needs a deterministic input to fit. Proposed
   `computeConfidence({ n, recencyDays, deviationStdRatio })` is a
   pure function the `generateInsight()` wrapper applies post-parse,
   discarding any number the model picked. Mitigates the "hallucinated
   high confidence on low data" failure mode that v1.4.15 C1 already
   defended against for citations.

3. **Comparison views (B8) intersect Insights — narrate, don't
   contradict.** When the user toggles Vormonat/Vorjahr, the
   prompt's snapshot must include a `comparison` block AND the
   per-rec rationale should prefer the matching window. The UI's
   `<RationaleCard>` shows a "(matches active comparison)" badge
   when aligned, with a one-tap to re-align when not — keeps the
   user's mental model coherent across chart, tile, and insight
   surface.

## Phase order recommended

B5a → B5b → B5c (defines rec-card layout) → B5d (plugs into the
layout) → B5e (Prisma migration; provider attribution available) →
B8 (chart-and-prompt-side, lands last so the prompt is fully shaped).

If the v1.4.16 budget tightens: B5a + B5c + B5d is the smallest
cohesive slice that delivers user-visible explainability + confidence.

## Commits this dispatch

1. `chore(planning): elevate B5c/d/e + B8 for v1.4.16` — STATE+ROADMAP.
2. `docs(planning): v1.4.16 ecosystem research for explainability +
confidence + feedback + comparison views` — research doc + this
   summary.

Both pushed to origin/main.
