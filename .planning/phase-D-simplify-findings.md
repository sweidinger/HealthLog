# Phase D — Simplify/Refine review findings (v1.4.16)

Reviewer: simplify agent (parallel — phase-D wave, 1 of 6)
Scope: `git diff --name-only v1.4.15...HEAD` — v1.4.16 changed source files only.
Constraint: chart presentation polish (B1a/B1b) was the explicit milestone goal — visual choices are not flagged.
Mode: autonomous, no commits, no edits — output only.

Findings ordered roughly by impact. "Apply autonomously? yes" = low-risk delete / inline; "no" = needs Marc's call.

---

## Finding 1 — `runWithFallback` (strict variant) + `RunWithFallbackParams` / `RunWithFallbackResult` are test-only

**File:** `src/lib/ai/provider-runner.ts:136-288`

**Type:** speculative / dead

**Why it's a smell:** v1.4.16 ships TWO variants of the chain runner: the legacy `runRawCompletionWithFallback` (raw provider call, no schema enforcement) and the strict `runWithFallback` (wraps `generateInsight()` for parsed schema-enforcement). Production is wired to ONE: `/api/insights/generate/route.ts:280` calls only `runRawCompletionWithFallback`. The strict `runWithFallback`, plus its `RunWithFallbackParams` and `RunWithFallbackResult` interfaces, are imported solely by `src/lib/ai/__tests__/provider-runner.test.ts`. The file's own header comment even documents the migration as "v1.4.17 will migrate this route to the strict wrapper (B5c work) — at that point this helper is removed."

This is two-implementations-of-one-interface in disguise: 60 LOC of strict-wrapper plumbing + 27 LOC of test-only types pre-built for a v1.4.17 migration that hasn't happened. CLAUDE.md: "Don't add features, refactor, or introduce abstractions beyond what the task requires."

Verified:

```
$ grep -rn "runWithFallback" src/app
(no output — only runRawCompletionWithFallback is wired)
```

The transitive cost is real: `generateInsight()` is itself only reachable via the strict variant, so `GenerateInsightOutcome`, the corrective-retry retry logic in `tryOnce`, `applyConfidenceOverride`, `annotateCitationCoverage`, and `InsightSchemaError` are all reachable only from tests in v1.4.16.

**Suggested change:** Pick one of (a) or (b):

- **(a)** Delete `runWithFallback`, `RunWithFallbackParams`, `RunWithFallbackResult` from `provider-runner.ts`. Migrate the test suite to exercise `runRawCompletionWithFallback` for fallback semantics + the standalone `generateInsight()` for schema-enforcement semantics. Keeps `generateInsight()` available for the v1.4.17 migration but removes the speculative coupling.
- **(b)** Wire `/api/insights/generate/route.ts` to the strict variant NOW (the route already gets a `ProviderChainResolved[]`; the swap is one import + one call site). Then delete `runRawCompletionWithFallback` + its result interface. This is the eventual migration the comment promises — doing it now collapses the duplication.

Path-of-least-resistance is (a); (b) is the more honest answer to the duplication.

**Risk:** medium — both options touch live AI code paths; (b) is bigger but resolves the duplication permanently.

**Apply autonomously?** no — needs Marc's call on whether v1.4.16 is the right milestone for the migration (b) or just to defer (a).

---

## Finding 2 — `GenerateInsightOptions.confidenceContext` is a config-bag with one shape

**File:** `src/lib/ai/generate-insight.ts:197-275`

**Type:** speculative / premature abstraction

**Why it's a smell:** `generateInsight()` accepts an `options: GenerateInsightOptions` object whose only field is `confidenceContext?: ConfidenceContextResolver`. No production caller passes it; `provider-runner.ts:244` calls `generateInsight(candidate.instance, params)` with no third argument. Inside the function, the resolver always falls back to `DEFAULT_CONFIDENCE_RESOLVER`, which uses `metricSource.n` + `recencyDays=0` + `deviationStdRatio=null` — i.e. the formula has only ONE shape ever in production.

The doc-comment promises that "the route layer can supply a real value via the resolver", but the route layer doesn't. The whole `ConfidenceContextResolver` type, the `GenerateInsightOptions` interface, the `options.confidenceContext ?? DEFAULT_CONFIDENCE_RESOLVER` indirection, and the per-rec callback are scaffolding for a v1.4.17 enhancement (the file says "v1.4.17 will fit weights to thumbs-up rates"). CLAUDE.md: "Don't add config bags with one shape" / "Don't add features beyond what the task requires."

Verified:

```
$ grep -rn "confidenceContext" src/app
(no output)
```

**Suggested change:** Inline the default-resolver body into `applyConfidenceOverride`, drop the `options` parameter, drop the `GenerateInsightOptions` interface, drop the `ConfidenceContextResolver` type and the `DEFAULT_CONFIDENCE_RESOLVER` constant. The function becomes:

```ts
export async function generateInsight(
  provider: AIProvider,
  params: CompletionParams,
): Promise<GenerateInsightOutcome> { … }

function applyConfidenceOverride(parsed: AIInsightResponse): void {
  const overrides: Array<{ id: string; model: number | null; computed: number }> = [];
  for (const rec of parsed.recommendations) {
    const computed = computeConfidence({
      n: rec.metricSource.n ?? 0,
      recencyDays: 0,
      deviationStdRatio: null,
    });
    const modelValue = typeof rec.confidence === "number" ? rec.confidence : null;
    rec.confidence = computed;
    overrides.push({ id: rec.id, model: modelValue, computed });
  }
  …
}
```

When v1.4.17 actually needs the resolver injection, re-introduce it then with a real second caller — that's the time the abstraction earns its keep.

**Risk:** low — pure inlining. Tests that pass `options` need updating, but they're internal.

**Apply autonomously?** yes (with the caveat that one test will need its `confidenceContext: ...` passthrough removed; the test's existence is fine, just the `options` parameter goes).

---

## Finding 3 — `aiRecommendationRationaleSchema.referenceId` is a speculative optional field with no consumer

**File:** `src/lib/ai/schema.ts:119-126`

**Type:** speculative

**Why it's a smell:** The rationale schema accepts an OPTIONAL `referenceId` field on top of the rec-level `referenceId` (line 169). The doc-comment is candid: "this field stays optional so a future provider that wants to attach a reference at rationale-grain can do so without a schema bump." No production code reads `rationale.referenceId`; no UI surface displays it; the citation footnote in `recommendation-card.tsx:148` reads `norm.referenceId`, not `norm.rationale?.referenceId`. CLAUDE.md: "Don't add features … beyond what the task requires." The field is a v1.4.17+ option dressed up as part of the v1.4.16 contract.

Verified:

```
$ grep -rn "rationale\.referenceId\|rationale\?.referenceId" src
(no output)
```

**Suggested change:** Drop `referenceId: z.string().optional()` from `aiRecommendationRationaleSchema` (and its doc-comment block, lines 119-125). When v1.4.17 actually needs rationale-grain citations, re-add the field then.

**Risk:** low — optional, silent drop has zero runtime effect; only widens the parser's reject-set, which is the conservative direction.

**Apply autonomously?** yes.

---

## Finding 4 — `applyLastWorkingCache` doc-comment overstates the guarantee

**File:** `src/lib/ai/provider-runner.ts:193-211`

**Type:** comment (WHAT, slightly misleading)

**Why it's a smell:** The doc-comment says "Returns a NEW array; original is not mutated." That's true but misleading — the inner `splice` does mutate the COPY (`reordered.splice(idx, 1)`); the only real contract is that the input array is left intact. The "NEW array" caveat is also defensive against a non-existent caller pattern: nothing in the code path stores or compares the input array reference. CLAUDE.md: "Default to writing no comments. Don't explain WHAT — well-named identifiers do that."

**Suggested change:** Trim the comment to just the WHY:

```diff
-/**
- * Reorder the input chain so the cached "last working" provider is
- * tried first. Returns a NEW array; original is not mutated. When the
- * cache is cold (or the cached provider is not in the input list), the
- * original order is preserved.
- */
+/**
+ * Reorder the input chain so the cached "last working" provider is
+ * tried first. Cold cache or unknown provider → original order.
+ */
```

**Risk:** low — comment-only.

**Apply autonomously?** yes.

---

## Finding 5 — `RecommendationFeedbackSeverity` / `RecommendationFeedbackTimeRange` types duplicated from validation schema

**File:** `src/components/insights/recommendation-feedback.tsx:35-45`

**Type:** repetition (mild)

**Why it's a smell:** The component declares its own union types for severity and time-range:

```ts
export type RecommendationFeedbackSeverity = "info" | "suggestion" | "important" | "urgent";
export type RecommendationFeedbackTimeRange = "last7days" | "last30days" | "last90days" | "allTime";
```

These are byte-for-byte the same as the `z.enum(...)` lists in `src/lib/validations/recommendation-feedback.ts:18-30`. Two source-of-truth sites for the same closed enum invite drift — if v1.4.17 adds `"last180days"` to the validator, this component will silently accept-but-fail-to-display the new range until someone notices.

The repetition is small (4+4 strings) so on its own it sits below CLAUDE.md's "three similar lines is better than a premature abstraction" bar — BUT the abstraction already exists (the zod schema). The cost is just exporting `z.infer<typeof recommendationFeedbackSeverity>` aliases from the validation file.

Cross-call: `recommendation-card.tsx:288-300` already has a hand-rolled `asFeedbackTimeRange` switch over the same four values to validate the rec's timeRange before rendering the feedback row. Three sites of the closed enum, all transcribed.

**Suggested change:**

```ts
// recommendation-feedback.tsx — import from canonical source
import type {
  RecommendationFeedbackRequest,
} from "@/lib/validations/recommendation-feedback";

export type RecommendationFeedbackSeverity = RecommendationFeedbackRequest["recommendationSeverity"];
export type RecommendationFeedbackTimeRange = RecommendationFeedbackRequest["metricSourceTimeRange"];
```

Or even better: drop the local aliases entirely, use the canonical types directly. `asFeedbackTimeRange` in `recommendation-card.tsx` can also `import { recommendationFeedbackTimeRange }` and call `.safeParse(value).success ? value : null` — slightly more code than the switch but a single source of truth.

**Risk:** low — pure type-rewire.

**Apply autonomously?** yes (just the type re-export; leave `asFeedbackTimeRange` as-is until a fourth consumer appears).

---

## Finding 6 — `formatRelativeTime` justification "polyfill cost" is stale

**File:** `src/components/insights/insights-page-hero.tsx:43-66`

**Type:** comment (WHAT, factually questionable)

**Why it's a smell:** The doc-comment says the hand-rolled formatter "Avoids the `Intl.RelativeTimeFormat` polyfill cost on the client." `Intl.RelativeTimeFormat` has been baseline-supported in every browser HealthLog targets since 2018 (Chrome 71, Safari 14, Firefox 65) — there's no polyfill cost to avoid. The genuine WHY is the second sentence: "keeps every surface that renders relative times locked to the project's established translation vocabulary" (i18n consistency). That's a real reason; the polyfill claim is noise.

CLAUDE.md: "Default to writing no comments. Don't explain WHAT" — and "WHAT" includes false-positive justifications.

**Suggested change:** Trim to the true WHY:

```diff
-/**
- * Format a relative time using the i18n translation keys. Avoids the
- * `Intl.RelativeTimeFormat` polyfill cost on the client AND keeps every
- * surface that renders relative times locked to the project's
- * established translation vocabulary.
- *
- * Buckets: <1min → just now; <60min → N min ago; <24h → N h ago;
- * else N days ago.
- */
+/**
+ * Bucketed relative-time using i18n translation keys so every surface
+ * shares vocabulary. Buckets: <1m, <1h, <24h, else days.
+ */
```

**Risk:** low — comment-only.

**Apply autonomously?** yes.

---

## Finding 7 — `RecommendationCard` "data-slot" architecture comment block is over-narrating

**File:** `src/components/insights/recommendation-card.tsx:22-47`

**Type:** comment (WHAT)

**Why it's a smell:** The header comment block lists every named slot the card exposes (`rec-confidence-slot`, `rec-feedback-slot`, etc.) along with the v1.4.16 phase tag for each. Half of those slots are now FILLED — `<ConfidenceMeter>` (B5d) and `<RecommendationFeedback>` (B5e) both shipped in v1.4.16 and are visible in the same file. The comment still talks about them as "future" and as "named slots so B5d (confidence) and B5e (feedback) can plug in without touching this file" — but B5d / B5e DID touch this file (lines 20, 274-276, 363-365). The slot-vocabulary comment now describes a state that no longer exists.

CLAUDE.md: "Don't comment what the code does — comment why" + "Backward-compat shims for paths that no longer exist".

**Suggested change:** Replace the architectural narration with a one-sentence WHY:

```diff
-/**
- * v1.4.16 phase B5c — Oura-style RecommendationCard.
- *
- * Each recommendation lives in its own collapsible card. The
- * collapsed row shows: severity badge + rec text + named slot for
- * the future confidence-ring (B5d) + chevron toggle.
- *
- * Expanding reveals:
- *   - 3-row rationale card (Window / Compared to / Deviation)
- *   - mini-chart pinned to the rationale's data window via
- *     HealthChart's new `mini` + `windowOverride` props
- *   - citation footnote (B5a) when `referenceId` resolves
- *   - named slot for the future feedback-thumbs (B5e)
- *
- * Default state: collapsed. Chevron toggles `aria-expanded`. Plain-
- * string recs (legacy InsightResult shape) and recs without
- * `rationale` render as a non-expandable list item — there's nothing
- * to expand to. The legacy-payload CTA at the parent advisor card
- * level surfaces the regenerate prompt for those.
- *
- * Layout slots are deliberately named so B5d (confidence) and B5e
- * (feedback) can plug in without touching this file:
- *
- *   - data-slot="rec-confidence-slot"  → B5d ConfidenceRing
- *   - data-slot="rec-feedback-slot"    → B5e RecommendationFeedback
- */
+/**
+ * Collapsible recommendation card with severity badge, confidence
+ * meter, and an expandable rationale block (window / compared-to /
+ * deviation) + mini-chart. Plain-string and rationale-less recs
+ * render as a non-expandable row.
+ */
```

**Risk:** low — comment-only.

**Apply autonomously?** yes.

---

## Finding 8 — `RecommendationCard.normalise()` mirrors the public `InsightRecommendation` shape almost verbatim

**File:** `src/components/insights/recommendation-card.tsx:65-92`

**Type:** repetition / premature abstraction

**Why it's a smell:** The component declares a private `NormalisedRec` interface and a `normalise(rec)` helper that maps the union `InsightRecommendation` (string | object) into a struct with default-undefined fields. But the only "normalisation" the helper performs on the object branch is field-by-field copy (`text: rec.text, severity: rec.severity, …`) — every field is forwarded with the same name and type. The string branch produces `{ text: rec }`. So the entire `NormalisedRec` is just `{ text: string } | InsightRecommendationObject` collapsed to a single shape with all fields optional.

A simpler shape: a single helper `recAsObject(rec) → InsightRecommendationObject` that wraps the string branch:

```ts
function recAsObject(
  rec: InsightRecommendation,
): { text: string; severity?: ...; rationale?: ...; … } {
  return typeof rec === "string" ? { text: rec } : rec;
}
```

The `NormalisedRec` interface adds nothing the union type doesn't already say. This isn't blocking, but it's the smell of an abstraction that doesn't pull weight — particularly because the resulting fields (`norm.severity`, `norm.text`, etc.) are accessed identically to how a non-normalised object branch would be.

**Suggested change:** Replace `normalise` + `NormalisedRec` with the inline `typeof rec === "string"` check at the use site, OR with a single ~3-line `recAsObject` helper. Drop the interface.

**Risk:** medium — the normalised shape is consumed in 8+ sites in the same file; the rewrite is mechanical but spans the JSX. Worth a careful rebuild rather than a regex find-replace.

**Apply autonomously?** no — refactor touches the rendered DOM and warrants Marc's eye on the simplified version.

---

## Finding 9 — `pickProviderType` "PROMPT_VERSION snapshot" comment describes a missing feature

**File:** `src/lib/ai/feedback-attribution.ts:46-62`

**Type:** comment (WHY that doesn't fit the code)

**Why it's a smell:** The doc-comment for `pickProviderType` explains a per-call PROMPT_VERSION snapshot that the function does NOT do — the function only picks the providerType. The PROMPT_VERSION reading happens at the bottom of `resolveFeedbackAttribution()` (line 84) where it reads the constant directly, not from `details`. The "the current PROMPT_VERSION constant is always returned because the generator itself doesn't yet stash a per-payload prompt version" sentence is in the wrong function's doc-block — it belongs above `resolveFeedbackAttribution` (or above the constant import), not above `pickProviderType` which doesn't deal with PROMPT_VERSION at all.

CLAUDE.md: "Comment WHY — only when the WHY is true and visible from the code."

**Suggested change:** Trim `pickProviderType`'s doc-comment to just the priority order; move (or drop) the PROMPT_VERSION sentence:

```diff
 /**
- * Pure helper exported for unit tests so we can pin the priority order
- * (chainProviderType > providerType > "unknown") without hitting the
- * DB. The current PROMPT_VERSION constant is always returned because
- * the generator itself doesn't yet stash a per-payload prompt version
- * (research §3.B notes this is a v1.4.17 ratchet item; reading the
- * constant snapshots whatever's deployed when the rating fires).
+ * Pick provider attribution from a parsed audit-row details blob.
+ * Priority: chainProviderType > providerType > "unknown".
  */
 export function pickProviderType(details: AuditDetailsShape): string {
```

**Risk:** low — comment-only.

**Apply autonomously?** yes.

---

## Finding 10 — `legacy-payload.ts` `UnknownRec` interface is a single-use throwaway

**File:** `src/lib/ai/legacy-payload.ts:18-21`

**Type:** speculative

**Why it's a smell:** Module declares an `interface UnknownRec { rationale?: unknown }` that is referenced exactly once, two lines down, in a cast: `(rec as UnknownRec).rationale`. That's a 3-line abstraction for a 1-line need. The cast can be inline:

```ts
const rationale = (rec as { rationale?: unknown }).rationale;
```

…and the `UnknownRec` interface deleted.

**Suggested change:** Inline the cast, delete the interface.

```diff
-interface UnknownRec {
-  rationale?: unknown;
-}
-
 /**
  * Returns true when the payload is non-empty and at least one
  * recommendation lacks a rationale object …
@@ -45,7 +41,7 @@ export function isLegacyInsightPayload(payload: unknown): boolean {
     // Structured rec: rationale must be a populated object.
     if (rec === null || typeof rec !== "object") return true;
-    const rationale = (rec as UnknownRec).rationale;
+    const rationale = (rec as { rationale?: unknown }).rationale;
     if (
       rationale === undefined ||
```

**Risk:** low.

**Apply autonomously?** yes.

---

## Finding 11 — `SEVERITY_BORDER_CLASSES` duplicated across `recommendations-grid.tsx` and `insights-card.tsx`

**Files:**

- `src/components/insights/recommendations-grid.tsx:64-69` (+ `SEVERITY_BORDER_FALLBACK` line 71)
- `src/components/insights/insights-card.tsx:40-45` (+ `SEVERITY_BORDER_FALLBACK` line 47)

**Type:** repetition (anti-finding — flagged for record-keeping)

**Why it's NOT a finding to apply yet:** Identical 4-entry severity → border-class map plus a 1-line fallback constant. CLAUDE.md: "three similar lines is better than a premature abstraction." Two callsites; the 5-line table is a borderline candidate. A third callsite (the dashboard tile preview, the doctor-report PDF, …) would tip the balance.

The siblings ALSO have a `SEVERITY_RANK` table and `SEVERITY_BADGE_STYLES` table (in `recommendation-card.tsx` for the latter); collectively that's 3 tables × ~5 entries × 4 severities each. Collapsing them into a single `severity-tokens.ts` module ("urgent" → { rank, borderClass, badgeClass, heroWrapper }) would be the move when a 3rd consumer appears OR when the v1.4.17 prompt-version-aware coloring lands. Not yet.

**Suggested change:** None — flag for the next reviewer so the abstraction isn't proposed prematurely.

**Apply autonomously?** N/A.

---

## Finding 12 — `confidence-meter.tsx` band-comment block over-explains a 4-line policy

**File:** `src/components/insights/confidence-meter.tsx:4-23`

**Type:** comment (WHAT)

**Why it's a smell:** 20-line header comment explains the band-thresholds (>=80 / 50..79 / 25..49 / <25) and the colour mapping. Lines 46-51 already define `bandFor()` and lines 66-80 already declare the colour-by-band records — the code IS the documentation. CLAUDE.md: "Default to writing no comments. Don't explain WHAT — well-named identifiers do that." The genuine WHY is the "quiet-when-unsure" Apple research stance, but that's already a 1-liner inside `bandFor`'s context.

**Suggested change:** Replace the header block with the WHY-only:

```diff
-/**
- * v1.4.16 phase B5d — `<ConfidenceMeter>`.
- *
- * Renders a deterministic 0..100 confidence score (server-computed by
- * `computeConfidence()` and overridden in `generateInsight()`) as
- * either a 5-bar meter (default) or an SVG ring.
- *
- * Color bands match research §2.A "three-band visual" extended to 4
- * bands so the under-50 region splits into "low" + "draft":
- *
- *   - >=80: green ("high"), 5 bars / full ring
- *   - 50..79: yellow ("medium"), 3-4 bars
- *   - 25..49: orange ("low"), 2 bars / partial ring + caption
- *   - <25: "draft" pill REPLACES the meter — Apple's
- *     "quiet-when-unsure" affordance per research §2.A. The rec is
- *     drafted but the model isn't asserting it.
- *
- * aria-label always announces the numeric score so a screen reader
- * isn't blind to the visual band distinction. Mobile-friendly: the
- * bars variant fits in 56 px wide; the ring variant in 28×28.
- */
+/**
+ * Renders a 0..100 confidence score as a 5-bar meter (default) or SVG
+ * ring. Sub-25 replaces the meter with a "draft" pill ("quiet-when-
+ * unsure"). aria-label always carries the numeric value.
+ */
```

**Risk:** low — comment-only.

**Apply autonomously?** yes.

---

## Anti-findings (deliberately NOT flagged)

- **`shiftDailySeriesForward` / `averageValue` / `computeComparisonDelta` (`src/lib/charts/comparison-shift.ts`)** — three pure helpers, each with a clear WHY-comment about the v1.4.16 B8 brief + DST safety. All three are consumed by the dashboard tile-strip AND the chart wrapper. Real callers, narrow surface, justified.
- **`computeWindowTrend` (`src/lib/analytics/window-trend.ts`)** — pure helper extracted from inline chart logic; replaces a known-buggy "+0.0 kg/Woche" surface. Doc-comment explains the v1.4.16 A8b bug + the split-half rationale. Justified.
- **`isBpReadingInTarget` / `computeBpInTargetPct` (`src/lib/analytics/bp-in-target.ts`)** — file-header doc-comment is long but every paragraph is a numbered bug + fix narrative covering the v1.4.14 → v1.4.15 → v1.4.16 lineage. Genuine WHY for a regression-prone area; survives.
- **`prefersReducedMotion` (`src/lib/charts/reduced-motion.ts`)** — 25-line file for a `window.matchMedia` query that's used in 2 chart wrappers. Tiny, but the SSR-safe + try/catch shape repeats per-wrapper without it. Earned.
- **`HostMetricsChart.buildChartRows`** — exported pure helper for unit tests so the test doesn't render Recharts. Same pattern shipped in scatter-correlation-chart; consistent and useful.
- **`ConfidenceMeter`'s `variant` prop** — both `bars` (rec card, line 364) and `ring` (insights-card preview, line 107) are used in production. Two callsites with two different values; the prop pulls weight.
- **`provider-chain.ts` `parseProviderChain` + `serializeProviderChain` + `PROVIDER_CHAIN_DEFAULT`** — three callers (provider.ts resolver, provider-chain PUT route, parser-test). Real consumers + a defensive fallback path that the integration tests cover.
- **`legacy-payload.ts` `isLegacyInsightPayload`** — wired into `/api/insights/generate/route.ts:205` with a real CTA flow on the dashboard. Real consumer.
- **`feedback-attribution.ts` `resolveFeedbackAttribution`** — wired into the feedback API route + has a fallback constant. Real consumer.

---

## Summary

| #  | File:Line | Type | Apply autonomously? |
|----|-----------|------|---------------------|
| 1  | `src/lib/ai/provider-runner.ts:136-288` (strict `runWithFallback` test-only) | speculative | no |
| 2  | `src/lib/ai/generate-insight.ts:197-275` (`confidenceContext` config-bag) | speculative | yes |
| 3  | `src/lib/ai/schema.ts:119-126` (`rationale.referenceId` unused) | speculative | yes |
| 4  | `src/lib/ai/provider-runner.ts:193-211` (over-stated comment) | comment | yes |
| 5  | `src/components/insights/recommendation-feedback.tsx:35-45` (type duplication) | repetition | yes |
| 6  | `src/components/insights/insights-page-hero.tsx:43-66` (stale polyfill claim) | comment | yes |
| 7  | `src/components/insights/recommendation-card.tsx:22-47` (slot-block over-narration) | comment | yes |
| 8  | `src/components/insights/recommendation-card.tsx:65-92` (`normalise()` indirection) | repetition | no |
| 9  | `src/lib/ai/feedback-attribution.ts:46-62` (mis-placed PROMPT_VERSION comment) | comment | yes |
| 10 | `src/lib/ai/legacy-payload.ts:18-21` (`UnknownRec` interface single-use) | speculative | yes |
| 11 | `SEVERITY_BORDER_CLASSES` 2× — anti-finding | repetition | n/a |
| 12 | `src/components/insights/confidence-meter.tsx:4-23` (band-block WHAT-comment) | comment | yes |

**8 yes / 2 no** (excluding anti-finding 11).

---

## Notes for the dispatcher

- Findings 1 + 2 + 3 are clustered — they all stem from the same v1.4.17-scaffolding pattern (test-only strict variant, config-bag with one shape, optional speculative field). If Marc decides to defer the strict-variant migration to v1.4.17, all three could be tackled together in a single "tighten v1.4.16 AI surface" commit.
- Finding 5 + 11 both touch the severity-token vocabulary; if a third callsite appears before v1.4.17, both should collapse into a single `severity-tokens.ts` module. Until then, the type-import (F5) is cheap, the table-extract (F11) is not.
- All comment-only findings (4, 6, 7, 9, 12) are independently safe and could be rolled into a single hygiene commit.
