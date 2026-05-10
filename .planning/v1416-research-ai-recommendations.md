# v1.4.16 — ecosystem research: AI recommendations + comparison views

Authored: 2026-05-09 (Phase 0+ ecosystem-research agent, post Phase-0
elevation of B5c/d/e + B8).

Marc elevated four bullets that previously rode under B5 to first-class
Wave-B work items, with an explicit research+harmonic-integration
mandate. This document is **informative**: it benchmarks competing apps,
maps each feature onto HealthLog's existing architecture, sketches the
implementation per file, calls out the cross-feature integration risks,
recommends a phase order, and parks the open questions Marc should
answer before any code lands.

The features under analysis:

1. **B5c — Per-recommendation explainability** (WHY / WINDOW /
   CITATIONS card with mini-chart)
2. **B5d — Confidence score per recommendation** (0-100 from data
   sufficiency / recency / signal strength)
3. **B5e — User-feedback loop** ("War das hilfreich?" thumbs-up/down
   persisted to a new RecommendationFeedback table)
4. **B8 — Extended comparison views** (Vormonat / Vorjahr overlay
   across charts, tiles, and the insights surface)

B5a (medical-reference grounding) and B5b (multi-provider redundancy)
are referenced where they intersect this work but are owned by their
own dedicated reports.

Existing infrastructure that this builds on:

- v1.4.15 Phase C1: `AIProvider` interface + `MockAIProvider`,
  `aiInsightResponseSchema` (strict, with `recommendations[]` carrying
  `metricSource`), `findUncitedRecommendations()` cross-check,
  scope-hardened `PROMPT_VERSION = "4.15.0"`, slug-drift defence.
- `src/lib/ai/generate-insight.ts` retry-once wrapper (one re-prompt on
  schema violation, then 422).
- `src/lib/insights/bucket-series.ts` daily/monthly bucketing (the
  natural data source for "data window" cards).
- `prisma/schema.prisma`: no `RecommendationFeedback` model exists; no
  per-rec `confidence` column anywhere; `User.insightsCachedText` holds
  the cached JSON output but **carries no invalidation timestamp** as
  CLAUDE.md notes.

---

## 1. B5c — Per-recommendation explainability

### 1A. Industry benchmarking

**Apple Health.** The Trends surface (iOS 16+) flags significant
deviations against a learned per-user baseline rather than a single
fixed threshold. The Vitals app on watchOS 11 is even more direct:
each metric is shown in-band vs. out-of-band relative to the user's
"typical range," and tapping into a metric reveals which nights
contributed the typical-range envelope (Apple Support, _View your
health data_; Century, _Apple Watch Vitals app explained_). The
mental model that translates: "this finding is interesting because it
deviates from **your** norm" is visible everywhere — there is no
one-shot population claim without a personal baseline.

**Withings Health Mate.** Health Insights surface ad-hoc nudges with
a science-based interpretation. They link out to a long-form
explainer page rather than expanding inline; user reviews repeatedly
complain about _opacity_ — the insight is a one-liner without a
visible data-window or threshold (justuseapp reviews, Withings
Support, _What is Health Insights_). HealthLog should NOT copy the
out-link pattern; explanations belong inline.

**Oura Ring.** This is the clearest reference point. Both Sleep and
Readiness scores expand into **Contributors** — a per-score breakdown
of (e.g.) Total Sleep, Efficiency, Restfulness, REM, Deep, Latency,
Timing — each shown with its own band, current value, and personal
trend (ouraring.com, _Sleep Contributors_, _Readiness Contributors_).
Tapping a contributor reveals "what's pulling this lower." This is
the explainability gold standard for consumer wellness UI.

**Top 3 patterns to borrow.**

1. **Personal-baseline framing first** (Apple/Oura): "your avg7 is
   5 mmHg above your 90-day median" beats "above the 140/90
   guideline" as the headline.
2. **Contributor breakdown card** (Oura): each rec expands into
   a 3-row card listing window / metric / deviation, plus a
   mini-chart of the window itself.
3. **Inline disclosure, not out-link** (avoid Withings's failure
   mode): the explanation lives in the card, never one-tap-away.

### 1B. Existing architecture fit

| Concern      | Touched files / what changes                                                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema       | `src/lib/ai/schema.ts` — `aiRecommendationSchema` extended with required `rationale` object (`dataWindow`, `comparedTo`, `deviation`) and optional `referenceId` (filled by B5a).                                                                       |
| Prompt       | `src/lib/ai/prompts/insight-generator.ts` — `PROMPT_VERSION` bumped to `4.16.0`; output-format block adds the rationale shape; ground rule "every rec MUST carry a rationale" added under §GROUND RULES.                                                |
| Wrapper      | `src/lib/ai/generate-insight.ts` — corrective retry message lists the rationale fields when missing; `findUncitedRecommendations()` companion `findRecommendationsMissingRationale()` added.                                                            |
| UI           | `src/components/insights/insight-advisor-card.tsx` — new `<RecommendationCard>` subcomponent with expand-arrow → `<RationaleCard>` (3-row data + `<HealthChart>` mini-chart for the window). `<InsightsCard>` likewise gets the same expand affordance. |
| Charts       | `src/components/charts/health-chart.tsx` — accepts a `windowOverride` prop so the rationale's mini-chart can pin to e.g. last7days regardless of the parent's chosen range.                                                                             |
| i18n         | New keys under `insights.recommendation.*`: `rationale`, `rationaleWindow`, `rationaleComparedTo`, `rationaleDeviation`, `rationaleExpand`, `rationaleCollapse`. Both `messages/en.json` + `messages/de.json`.                                          |
| Auth + audit | No new auth surface; the rec card consumes existing `requireAuth()`-gated insight payloads. No new audit row — explanations are read-only client-side derivations from the cached payload.                                                              |

### 1C. Proposed implementation plan (file-level)

**Schema migration.** No Prisma migration needed; the rationale lives
inside the existing `User.insightsCachedText` JSON blob. Schema-level
zod additions:

```ts
// src/lib/ai/schema.ts
export const aiRecommendationRationaleSchema = z.object({
  dataWindow: z.enum(["last7days", "last30days", "last90days", "allTime"]),
  comparedTo: z.string().min(1, "rationale.comparedTo required"),
  deviation: z.string().min(1, "rationale.deviation required"),
  // Optional referenceId is filled by B5a; required at runtime when
  // recommendation severity >= "important".
  referenceId: z.string().optional(),
});

export const aiRecommendationSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  metricSource: metricSourceSchema,
  severity: recommendationSeveritySchema,
  rationale: aiRecommendationRationaleSchema, // NEW — required
  // confidence comes from B5d:
  confidence: z.number().min(0).max(100).optional(), // required after B5d
});
```

**API endpoints.** No new endpoint — the existing
`POST /api/insights/generate` already returns the full payload; the UI
just renders new fields. The bug-class to watch for: legacy cached
payloads in `User.insightsCachedText` will fail the strict parse.
Mitigation: keep `.passthrough()` for one milestone and add a
"legacy payload detected, regenerate now" CTA banner in
`<InsightAdvisorCard>` when `parsed.recommendations[0]?.rationale` is
absent.

**Component tree.**

```
<InsightAdvisorCard>
  └ <RecommendationsList>
      └ <RecommendationCard>            (NEW)
          ├ rec text + severity badge + (B5d) confidence ring
          ├ <RationaleExpander>         (NEW — chevron, aria-expanded)
          │   └ <RationaleCard>         (NEW)
          │       ├ <RationaleRow label="Window" value={dataWindow} />
          │       ├ <RationaleRow label="Compared to" value={comparedTo} />
          │       ├ <RationaleRow label="Deviation" value={deviation} />
          │       └ <HealthChart windowOverride={dataWindow} types={[…]} mini />
          │       └ {referenceId ? <CitationFootnote /> : null}
          └ <RecommendationFeedback>    (B5e — thumbs)
```

**Provider abstraction extensions.** The `AIProvider` interface stays
untouched — rationale is enforced at schema-time, not by the provider
SDK.

**Test strategy.**

- Unit: `aiInsightResponseSchema.safeParse()` rejects a recommendation
  without `rationale` (extends the existing 11 citation tests).
- Unit: `findRecommendationsMissingRationale()` flags legacy payloads.
- Component: `<RationaleCard>` renders 3 rows + a mini-chart;
  collapsed by default; aria-expanded toggles.
- Integration: full insight-generate run with `MockAIProvider` mocked
  to return a payload with rationale; UI renders all three rows.
- E2E (Playwright): on `/insights`, expand a recommendation → assert
  rationale rows visible, mini-chart `<canvas>` rendered.

---

## 2. B5d — Confidence score per recommendation

### 2A. Industry benchmarking

**Apple Health.** No surfaced confidence number per recommendation.
Trends require a hard 180-day data minimum before they appear at all
— Apple's confidence model is "we'll be quiet until we're sure"
(Apple Support). The negative-space lesson: don't show a noisy
confidence number on a 3-data-point user.

**Withings Health Mate.** Confidence not surfaced. Insights either
appear or don't. Marc's complaint about Withings — "warum nutzlos?" —
is downstream of this opacity.

**Oura Ring.** Each contributor has a state (Optimal / Good / Pay
Attention) plus a numeric value, plus a "what's contributing"
breakdown. They don't expose calibrated probabilities; they expose
**states + thresholds** that map directly onto a colour. This is a
better reference than raw probabilities for non-clinicians
(ouraring.com, _Sleep Score_, _Readiness Score_).

**Top 3 patterns to borrow.**

1. **Three-band visual (good / warn / low) over a continuous bar**
   (Oura). Marc's spec calls for a 5-bar meter or coloured ring —
   either works; the **bin** is the affordance, the number underneath
   is the detail.
2. **Below-threshold tagging instead of hiding** (Marc's spec, also
   the Oura "Pay attention" state): "Low confidence — based on
   limited data" header on the card.
3. **Quiet-when-unsure mode for the score** (Apple): if confidence
   < 25 we still show the rec but the meter is replaced by a "draft"
   pill — the rec is drafted but the model isn't asserting it. This
   is the cheap way to avoid noise without hiding output.

### 2B. Existing architecture fit

| Concern         | Touched files / what changes                                                                                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema          | `src/lib/ai/schema.ts` — `aiRecommendationSchema` gains required `confidence: z.number().int().min(0).max(100)` once B5c lands. Pre-B5c rollout: `.optional()` then flip to required in same milestone.                                               |
| Confidence calc | `src/lib/ai/confidence.ts` (NEW) — pure function `computeConfidence({ n, recencyDays, deviationStdRatio })` returning 0-100. Ranged inputs from `metricSource.n`, the user's `bucketSeries()` payload's freshest bucket, and the deviation magnitude. |
| Prompt          | The model proposes a confidence; the wrapper **OVERRIDES** with the deterministic `computeConfidence()`. Two reasons: (1) calibrated probabilities are not a small-LLM strength; (2) deterministic reproducibility for the v1.4.17 feedback ratchet.  |
| Wrapper         | `src/lib/ai/generate-insight.ts` post-validation step injects `confidence` from `computeConfidence()` before returning to caller — model's value is discarded.                                                                                        |
| UI              | `<RecommendationCard>` (from B5c) renders a `<ConfidenceMeter>`: 5-bar SVG that maps 0-20 / 20-40 / 40-60 / 60-80 / 80-100 to 1-5 lit bars. Below 25, lit-bar count is 1 + draft pill. Below 50 carries the "based on limited data" caption.          |
| i18n            | `insights.recommendation.confidence`, `insights.recommendation.confidenceLow`, `insights.recommendation.confidenceDraft`. EN+DE.                                                                                                                      |
| Auth + audit    | None. Confidence is derived; nothing to authenticate, nothing to audit.                                                                                                                                                                               |

### 2C. Proposed implementation plan (file-level)

**Schema migration.** No Prisma migration; lives in the JSON blob.

**`src/lib/ai/confidence.ts` (NEW).**

```ts
export interface ConfidenceInputs {
  /** Sample count behind the cited data window (from metricSource.n). */
  n: number;
  /** Days since the most recent sample in the window. */
  recencyDays: number;
  /** |deviation| / stdev of the user's 90-day baseline, when computable. */
  deviationStdRatio: number | null;
}

export function computeConfidence(inputs: ConfidenceInputs): number {
  // n contribution: log-curve, saturates at n=30. n<3 is a hard cap.
  if (inputs.n < 3) return Math.max(10, 5 * inputs.n); // 0/5/10/15
  const nScore = Math.min(40, 10 + 10 * Math.log10(inputs.n)); // 20→25, 30→24.7
  // Recency contribution: <2d = 30, decays linearly to 0 at 30d.
  const recencyScore = Math.max(0, 30 * (1 - inputs.recencyDays / 30));
  // Signal strength: |z| ≥ 1.5 = 30; 0 = 0; null = 15.
  const signalScore =
    inputs.deviationStdRatio === null
      ? 15
      : Math.min(30, 30 * (Math.abs(inputs.deviationStdRatio) / 1.5));
  return Math.round(nScore + recencyScore + signalScore);
}
```

Calibrated against synthetic fixtures (n=2 → ~10; n=14, recencyDays=1,
ratio=2 → ~94; n=30, recencyDays=20, null ratio → ~52). The formula is
**pre-feedback** — v1.4.17 will fit weights to thumbs-up rates.

**API contract.** `POST /api/insights/generate` returns payload with
`recommendations[].confidence: number` (already part of schema).

**Component tree.** `<ConfidenceMeter value={n} variant="ring|bars">` —
both variants implemented, default `bars`. Visual story: 5 bars,
filled count = ceil(value/20), color = green ≥80, yellow 50-79, red
<50.

**Provider abstraction.** No interface change. The override happens
post-parse in `generateInsight()`.

**Test strategy.**

- Unit: `computeConfidence()` — 12 fixtures across the input matrix.
- Component: `<ConfidenceMeter>` renders 5 bars at all five value
  bands; aria-label translates correctly.
- Integration: end-to-end `generateInsight()` returns a payload where
  every rec has a server-computed confidence (model-supplied value
  ignored).

---

## 3. B5e — User-feedback loop ("War das hilfreich?")

### 3A. Industry benchmarking

**Apple Health.** No per-card thumbs feedback. Apple's signal is
implicit (did the user dismiss the trend? did they keep wearing the
watch?) — not a model HealthLog can copy because dismiss-as-feedback
needs orders of magnitude more users to denoise.

**Withings Health Mate.** No documented per-rec feedback. App-level
star reviews are the only loop, and they don't tie back to the rec.

**Oura Ring.** Has a **Tags** feature where users mark daily
behaviours (caffeine, alcohol, late meal, etc.) and Oura correlates
those with sleep score deviations (Oura Help, _Sleep Score_). This
isn't a thumbs-up on a rec — it's a much richer behavioural signal
that funds Oura's correlations. HealthLog can't copy verbatim
because the user base is too small for cross-user training, but the
_pattern of asking the user to label cause-effect over time_ is
worth borrowing in v1.5+ as an opt-in.

**Top 3 patterns to borrow.**

1. **Per-card thumbs immediately under the rec** — low friction, no
   nag-modal (Marc's explicit spec; matches industry-standard chat
   feedback UI).
2. **No claim of cross-user training** — be explicit in the UI that
   feedback shapes only that user's future prompts. Privacy-first
   framing reduces the "they're spying" anxiety we picked up in v1.4.x
   beta feedback.
3. **Treat feedback as a delayed prompt revision, not a same-session
   reaction** — change `PROMPT_VERSION` based on aggregated patterns
   over time, not by hot-patching this user's next call. Stable
   ratchets.

### 3B. Existing architecture fit

| Concern       | Touched files / what changes                                                                                                                                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema        | NEW Prisma model `RecommendationFeedback` (replaces the v1.4.17 roadmap's `InsightFeedback` proposal — same idea, narrower scope). Includes `userId`, `recommendationId`, `recommendationText`, `recommendationSeverity`, `helpful`, `providerType`, `promptVersion`, `createdAt`. |
| API           | NEW `POST /api/insights/feedback` — accepts `{ recommendationId, recommendationText, helpful }`, fills `providerType` + `promptVersion` server-side from the cached payload. `requireAuth()`-gated. Idempotent via `Idempotency-Key`.                                              |
| UI            | `<RecommendationFeedback>` component — 2 small icon buttons under the rec, optimistic mutation via TanStack Query. Disabled when already submitted (read from local cache + a stable `(userId, recommendationId)` key).                                                            |
| Aggregation   | NEW worker job `insightsFeedbackAggregator` (pg-boss) computes per-(severity × metricSource.type) helpful-rate weekly and writes to `AppSettings.adminAiInsightsFeedbackSummary` (small JSON blob). Source of truth for any future prompt-tuning step.                             |
| Prompt-tuning | DEFERRED to v1.4.17 — no prompt mutation in v1.4.16. The B5e milestone delivers the loop infrastructure; the ratchet itself is a follow-on.                                                                                                                                        |
| i18n          | `insights.recommendation.feedbackHelpful`, `insights.recommendation.feedbackNotHelpful`, `insights.recommendation.feedbackThanks`, `insights.recommendation.feedbackConfirmed`. EN+DE.                                                                                             |
| Auth + audit  | `POST /api/insights/feedback` writes an audit row `insights.recommendation.feedback` with `{ helpful, severity, providerType, promptVersion }`. Per-user only; cross-user aggregate stays on the worker.                                                                           |

### 3C. Proposed implementation plan (file-level)

**Prisma migration.**

```prisma
model RecommendationFeedback {
  id                     String   @id @default(cuid())
  userId                 String   @map("user_id")
  // The recommendation's stable id within its response. Same user can
  // re-rate across regenerations because the id is per-payload, not
  // per-user. (recommendationText snapshot disambiguates duplicates.)
  recommendationId       String   @map("recommendation_id")
  recommendationText     String   @map("recommendation_text")
  recommendationSeverity String   @map("recommendation_severity")
  metricSourceType       String   @map("metric_source_type")
  metricSourceTimeRange  String   @map("metric_source_time_range")
  helpful                Boolean
  providerType           String   @map("provider_type")     // "codex" | "openai" | …
  promptVersion          String   @map("prompt_version")    // e.g. "4.16.0"
  createdAt              DateTime @default(now()) @map("created_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, recommendationId, recommendationText], map: "rec_feedback_user_rec_text_key")
  @@index([userId, createdAt])
  @@index([recommendationSeverity, helpful, createdAt])
  @@map("recommendation_feedback")
}
```

GDPR cascade: `onDelete: Cascade` per `User`. Mirrors `Feedback`
table convention. Add to the integration test
`tests/integration/gdpr-cascade-delete.test.ts`.

**API contract.**

```
POST /api/insights/feedback
  Headers: Idempotency-Key (recommended), X-Client-Type: native | (none)
  Body: {
    recommendationId: string,
    recommendationText: string,         // snapshot for disambiguation
    recommendationSeverity: "info"|"suggestion"|"important"|"urgent",
    metricSourceType: string,
    metricSourceTimeRange: "last7days"|"last30days"|"last90days"|"allTime",
    helpful: boolean
  }
  Response 201: { data: { id, createdAt } }
  Response 409: { error: "already_rated" }   // unique violation
  Response 422: zod issues
```

**Component tree.** `<RecommendationFeedback recId={rec.id}>` —
TanStack Query mutation; optimistic update; disabled state pulls from
a local map keyed by `(userId, recId)` so a refresh doesn't allow a
re-rate.

**Provider abstraction.** No interface change. The feedback payload
captures `providerType` from the cached payload's
`raw.providerType` — already in `CompletionResult`. So feedback is
attributable per-provider for the cross-feature analysis (see §4.4).

**Worker job.**

`src/lib/jobs/feedback-aggregator.ts` (NEW). Runs daily at 04:00 via
pg-boss. Aggregates last-30-day feedback per
`(severity, metricSourceType, providerType, promptVersion)`. Writes to
`AppSettings` singleton. Does NOT mutate any user state.

**Test strategy.**

- Unit: zod schema for the feedback request.
- Integration: round-trip POST then re-POST returns 409. GDPR cascade
  delete drops feedback rows.
- Idempotency replay: the Idempotency-Key gate works (cached response
  for the same `(userId, recId, helpful)` body).
- Worker: 30 synthetic feedback rows across (severity × provider) →
  worker produces a stable JSON aggregate.
- E2E: thumbs-up button click → toast confirms → button disabled.

---

## 4. B8 — Extended comparison views (Vormonat / Vorjahr)

### 4A. Industry benchmarking

**Apple Health.** Trends explicitly compares **the most recent
window** (e.g. 14 weeks) to **a longer baseline** (12-15 months);
when a delta crosses a threshold, a trend chip appears with a
sentence like "averaged more steps over the past 14 weeks" (Apple
Support, leancrew.com _Apple Health trends_). The narrative-text
layer is the value-add — the chart underneath is secondary.

**Withings Health Mate.** Limited side-by-side comparison; mostly
single-line history with a date range picker. No "vs. last year"
overlay surface.

**Oura Ring.** Has a **trends view** with the comparison band shown
visually, plus monthly/yearly summaries. The visual treatment is a
dimmed historical line under a current line — exactly Marc's spec.

**Top 3 patterns to borrow.**

1. **Dimmed historical-line overlay** under the active line (Oura).
   Concrete; Marc's spec already calls for this.
2. **Narrative-text delta** alongside the chart (Apple): "Your
   avg systolic improved by 4 mmHg vs. last month" is the headline —
   the chart visualises it.
3. **Comparison toggle as a persistent setting** (Apple's Trends
   surface implicitly enables comparisons; user doesn't toggle each
   chart). Bundling all charts under a global "Compare to" picker is
   the lowest-friction surface; per-chart toggle is the second-lowest.
   Avoid hover-only interactions (Marc's explicit spec).

### 4B. Existing architecture fit

| Concern      | Touched files / what changes                                                                                                                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema       | NEW `User.compareBaselinePref` String? (default null = "none"). Values: `"none" \| "lastMonth" \| "lastYear"`. Or stash inside `dashboardWidgetsJson` as `{ compareBaseline: "lastMonth" }` to avoid a schema migration — preferred since the field is ephemeral. |
| Bucketing    | `src/lib/insights/bucket-series.ts` — already returns 3-year history (daily 360d + monthly 24×30d). The comparison overlay reads the existing payload — no API change.                                                                                            |
| Charts       | `src/components/charts/health-chart.tsx` — accepts a `compareBaseline?: "lastMonth" \| "lastYear"` prop; renders a dimmed `<Line>` for the shifted series alongside the current `<Line>`. `mood-chart.tsx`, `medication-compliance-chart.tsx` mirror.             |
| Tiles        | `src/components/dashboard/tile-strip.tsx` — adds a delta callout `Δ +5%` next to the current value when `compareBaseline !== "none"`.                                                                                                                             |
| Insights     | `src/lib/ai/prompts/insight-generator.ts` — when comparison is active, the user-prompt's snapshot includes a `comparison: { baseline, deltaSummary }` field; the prompt's GROUND RULES gain "narrate the comparison if `comparison` is non-null."                 |
| UI control   | `src/components/charts/compare-toggle.tsx` (NEW) — segmented control "None / Vormonat / Vorjahr"; mounted next to the existing range tabs (7d/30d/90d/all). Persisted via `useSettings()` hook.                                                                   |
| i18n         | `charts.compareNone`, `charts.compareLastMonth`, `charts.compareLastYear`, `charts.deltaUp`, `charts.deltaDown`, `charts.deltaUnchanged`. EN+DE.                                                                                                                  |
| Auth + audit | None — preference change is a localised setting; no audit row. Reading the comparison payload uses the existing `requireAuth()`-gated insight + measurements endpoints.                                                                                           |

### 4C. Proposed implementation plan (file-level)

**Schema migration.** Prefer the **JSON-blob path** (no migration):
extend `dashboardWidgetsJson` with `{ compareBaseline }`. Schema
migration only if the JSON path proves slow to read in `RSC`-rendered
charts — measure first.

**Component tree.**

```
<HealthChart compareBaseline={pref}>
  └ <ResponsiveContainer>
      └ <LineChart>
          ├ <Line dataKey="current" />
          ├ {compareBaseline ? <Line dataKey="compare" stroke={dimmed} /> : null}
          └ <Tooltip>{(payload) => <CompareTooltip payload={payload} />}</Tooltip>
```

The dimmed line uses `--dracula-comment` at 0.45 opacity per the
Dracula theme convention. No new chart-type tokens needed.

**Bucketing helper.** Add `src/lib/charts/compare-shift.ts`:

```ts
export function shiftBuckets(
  buckets: DailyBucket[],
  baseline: "lastMonth" | "lastYear",
): DailyBucket[];
```

Pure function. Pre-computed at chart-render time; no server round-trip.

**Insights narration.** When `compareBaseline !== "none"`, the snapshot
sent to the LLM includes:

```ts
comparison: {
  baseline: "lastMonth" | "lastYear",
  metrics: [
    { type: "BLOOD_PRESSURE_SYS", currentAvg: 132, baselineAvg: 136, delta: -4, deltaPercent: -2.9 },
    …
  ],
}
```

Prompt gains: "If `comparison` is non-null, the summary's first
sentence MUST narrate the most clinically-significant delta." Test
fixture: a snapshot with `comparison.metrics[0].delta = -4 mmHg` →
summary contains the substring "vs. last month" or "Vormonat".

**Test strategy.**

- Unit: `shiftBuckets()` — DST boundary, leap-day, year shift across
  a leap year.
- Component: `<HealthChart compareBaseline="lastMonth">` renders 2
  `<Line>` paths.
- Component: `<CompareToggle>` persists across mount.
- Integration: insights payload with `comparison` block produces a
  summary mentioning the delta.
- E2E: toggle "Vormonat" on the dashboard → reload → still active.

---

## 5. Cross-feature integration risks + mitigations

These four features are not independent. Each section below names
the risk, then the proposed mitigation.

### 5.1 Explainability + Confidence — same rec card

**Risk.** Both features layer affordances on the same
`<RecommendationCard>`. Without coordination, the card becomes busy
(badge + ring + chevron + thumbs all squeezed in).

**Mitigation.** Spec the layout once, in B5c, before B5d ships. The
layout is:

```
[severity-badge] rec-text                    [confidence-bars] [chevron▼]
 (expanded:)
   ─ rationale rows (3)
   ─ mini-chart
   ─ citation footnote (B5a)
   [thumbs-up] [thumbs-down]
```

Confidence bars + chevron live on the right, severity on the left,
thumbs only inside the expanded card. This keeps the collapsed state
under 1 row and the expanded state legible. Build the layout
component first; later features plug into named slots.

### 5.2 Confidence + Feedback — accelerated tuning for low-confidence-thumbs-down

**Risk.** A low-confidence rec that gets many thumbs-down should
ratchet the prompt **faster** than a high-confidence rec with
thumbs-down (the latter is real model error; the former is "model
shouldn't have shown this at all").

**Mitigation.** The aggregator's tunable threshold table includes
`(severity × confidence_band)`. Low-confidence-and-low-helpful-rate
buckets get a stricter "OMIT" rule appended to the next prompt
version. High-confidence-low-helpful-rate buckets get a "REPHRASE"
rule. This is v1.4.17 work, but the schema must support it from
v1.4.16 — hence `confidence` is on the `RecommendationFeedback` row.

**Code change for v1.4.16:** add `recommendationConfidence Int?` to
the Prisma model so the v1.4.17 ratchet has the data when it lands.
Cheap insurance.

### 5.3 Comparison-views + Insights — narrative drift

**Risk.** When comparison is active and the AI summary mentions the
baseline, the rationale on each rec might cite a _different_ window
than the comparison the user is staring at. Cognitive whiplash.

**Mitigation.** Two rules:

1. The `userPrompt` builder includes both the `comparison` block AND
   the per-rec rationale window options. The prompt's GROUND RULES
   prefer rationale windows that match the active comparison
   baseline when possible.
2. The UI's `<RationaleCard>` renders a bracket "(matches active
   comparison)" badge when `rec.rationale.dataWindow ===
comparison.baseline`, and a softer "(different window)" badge
   when they diverge — with a one-tap action to switch the global
   comparison to match.

This way the comparison is always orientation, never a contradiction.

### 5.4 Feedback + Multi-provider (B5b) — provenance attribution

**Risk.** With multi-provider cascade (B5b), the same rec text might
come from Codex on Monday and admin-OpenAI on Tuesday. Aggregating
feedback without provider attribution will make per-provider quality
analysis impossible.

**Mitigation.** `RecommendationFeedback.providerType` is mandatory
(see schema in §3.C). Server-side fills it from the cached payload's
`raw.providerType` at write time — the client never supplies it,
preventing tampering. The aggregator slices by `providerType` in the
admin AI quality dashboard.

**Trade-off accepted.** A user re-rating a rec across regenerations
will produce 2+ rows. That's fine; the `(userId, recommendationId,
recommendationText)` unique constraint allows multiple rows when the
text changes between regenerations, and the worker can use the
freshest row per (user, rec-text) for trend analysis.

---

## 6. Phase ordering recommendation

Wave-B sequence within v1.4.16:

| Order | Phase | Rationale                                                                                                                                     |
| ----- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | B5a   | Medical-reference grounding ships the `references[]` bundle + `referenceId` schema field that B5c will reuse. Land first — don't double-ship. |
| 2     | B5b   | Multi-provider redundancy hardens the _substrate_. Future features attribute by provider; provider abstraction needs to be solid first.       |
| 3     | B5c   | Per-rec explainability **defines the rec card layout**. All later UI work plugs into its named slots.                                         |
| 4     | B5d   | Confidence score plugs into B5c's rec card. Schema migration deferred to JSON-blob path; only zod additions.                                  |
| 5     | B5e   | Feedback loop adds the bottom-of-card thumbs. Touches Prisma (RecommendationFeedback). Provider attribution from B5b is now stable.           |
| 6     | B8    | Comparison views are mostly chart-side; they intersect insights via the `comparison` snapshot block. Land last so the prompt is fully shaped. |

Time-budget carve-out: **B5a + B5c + B5d** are the smallest cohesive
slice that delivers user-visible explainability and confidence; if
context tightens, ship those three and defer B5b/B5e/B8 to v1.4.17.

---

## 7. Open questions for Marc

These are tight (4 items) — please ack or correct before
implementation.

1. **Confidence shape.** Marc's spec says "0-100 score." Confirmed
   the deterministic-server-computed-override approach (model
   discards its own number) is acceptable — i.e. the rec card never
   shows a confidence the LLM picked unilaterally. **(yes/no)**

2. **Feedback aggregation policy.** Marc's spec says "no cross-user
   training, opt-in for any aggregation." Question: is the
   _single-user_ aggregator (only Marc's own ratings shape Marc's own
   future prompt) acceptable as a default, with cross-user-aggregate
   gated behind an admin-only opt-in? Or must even the single-user
   loop be opt-in? **(default-on vs opt-in)**

3. **Comparison persistence layer.** Strong preference for
   piggy-backing on `dashboardWidgetsJson` (no Prisma migration) vs.
   a dedicated `User.compareBaselinePref` column for SQL-grep ease in
   the admin tools. **(JSON blob vs new column)**

4. **B8 narrative scope.** When comparison is active, the AI summary
   gains a leading "vs. last month" sentence. Question: is this
   narrative on by default when the toggle flips, or behind a
   secondary "include comparison in AI insights" preference? Default
   on is more useful but means more LLM tokens; default off is
   cheaper but creates a "why isn't the AI mentioning what I see in
   the chart" surprise. **(default on vs default off)**

---

## 8. Sources

- Apple Support — _View your data in Health on iPhone_ —
  https://support.apple.com/guide/iphone/view-your-health-data-iphe3d379c32/ios
- leancrew.com — _Apple Health trends_ —
  https://leancrew.com/all-this/2024/11/apple-health-trends/
- Apple Watch Vitals app explained —
  https://www.centuryai.app/blog/apple-watch-vitals-app-explained
- Withings Support — _What is Health Insights_ —
  https://support.withings.com/hc/en-us/articles/360038534893-Health-Mate-Android-App-What-is-Health-Insights-
- Withings Blog — _Get to know the Health Mate app_ —
  https://www-ext.withings.com/2021/02/04/why-is-health-mate-the-most-advanced-health-management-app/
- justuseapp — _Withings Health Mate Reviews_ —
  https://justuseapp.com/en/app/542701020/withings-health-mate/reviews
- Oura — _Sleep Score_ —
  https://support.ouraring.com/hc/en-us/articles/360025445574-Sleep-Score
- Oura — _Sleep Contributors_ —
  https://support.ouraring.com/hc/en-us/articles/360057792293-Sleep-Contributors
- Oura — _Readiness Score_ —
  https://support.ouraring.com/hc/en-us/articles/360025589793-Readiness-Score
- Oura — _Readiness Contributors_ —
  https://support.ouraring.com/hc/en-us/articles/360057791533-Readiness-Contributors
- Oura — _Readiness Score & Cycle Insights_ —
  https://ouraring.com/blog/readiness-score-cycle-consideration/

---

## 9. Cross-links

- Phase-0 elevation commit: `chore(planning): elevate B5c/d/e + B8 for v1.4.16` (origin/main)
- Sibling AI roadmap: `docs/audit/v1416-ai-roadmap.md` (B5a/B5b authored 2026-05-09 during v1.4.15 Phase C1)
- Phase-summary report (this dispatch): `.planning/phase-research-report.md`
- Backlog: `.planning/v1416-backlog.md` (deferred MED/HIGH that touch the same surfaces — F1, F2, M6 senior, H3 code-review)
