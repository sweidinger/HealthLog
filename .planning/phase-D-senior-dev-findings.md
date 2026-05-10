# Phase D — Senior-dev review (v1.4.16)

Lens: structure, file-size discipline, naming, separation of concerns,
layering coherence, test architecture, premature abstraction. Distinct
from code-review (correctness/bugs), security, design, simplify.

Scope: 167 changed files in `git diff v1.4.15...HEAD` (+20,357 / −2,031
lines). Focus on the largest deltas: AI module (`src/lib/ai/` grew with
B5a refs, B5b chain runner, B5c rationale, B5d confidence, B5e feedback),
chart wrappers (`health-chart.tsx` +729, `mood-chart.tsx` +542), the
recommendations surface (`<RecommendationCard>` 417 new lines,
`<RecommendationsGrid>`, `<RecommendationFeedback>`, `<ConfidenceMeter>`),
admin extensions (host-metrics, app-logs, audit-log filters, ai-quality),
and B7's settings-export consolidation.

Verdict at a glance: **0 CRITICAL, 3 HIGH, 9 MED/LOW**. The marathon
hit its file-size target overall — only one v1.4.16-touched file is
visibly over the comfortable ceiling and the named-slot pattern in
`<RecommendationCard>` kept it under 420 lines despite five buckets
plugging into it. Worktree adoption (last milestone's H3) worked well:
the cross-agent staging races mostly fall into "wrong commit subject"
territory rather than lost code. The findings below are real maintenance
debt; none of them block the v1.4.16 ship.

---

## CRITICAL — none

(No architectural mistakes need fixing before v1.4.16 ships.)

---

## HIGH

### H1 — `src/lib/ai/` directory has 19 flat files (4,726 lines) with five orthogonal responsibility groups; the named-slot success of `<RecommendationCard>` shows the AI module deserves the same sub-directory split

- **Files / pattern**: `/Users/marc/Projects/HealthLog/src/lib/ai/` —
  `provider.ts` (515), `codex-client.ts` (484), `provider-runner.ts`
  (371), `codex-oauth.ts` (366), `schema.ts` (329), `generate-insight.ts`
  (315), `medical-references.ts` (185), `provider-chain.ts` (137),
  `types.ts` (132), `confidence.ts` (102), `citation-coverage.ts` (94),
  `local-client.ts` (92), `openai-client.ts` (88), `feedback-attribution.ts`
  (86), `legacy-payload.ts` (55), plus `prompts/` already split out.
- **Issue**: Five distinct concerns sit at the same flat depth, all
  importing each other:
  - **Provider clients**: `codex-client.ts`, `codex-oauth.ts`,
    `codex-slug-cache.ts`, `openai-client.ts`, `anthropic-client.ts`,
    `local-client.ts`, `mock-client.ts` (7 files).
  - **Provider resolution / chain runtime**: `provider.ts`,
    `provider-chain.ts`, `provider-runner.ts` (3 files; `provider.ts`
    AND `provider-runner.ts` both export 4 different
    "resolve/run" entry points that route layers must navigate).
  - **Schema / validation / types**: `schema.ts`, `types.ts` —
    two response shapes still co-exist (last milestone's M6 — see
    M5 below for the v1.4.16 update).
  - **Domain logic**: `confidence.ts`, `citation-coverage.ts`,
    `legacy-payload.ts`, `feedback-attribution.ts`,
    `medical-references.ts`, `generate-insight.ts`.
  - **Prompts**: `prompts/` already a sub-directory (the only one).
  Today an AI-feature add lands one file in the flat `ai/` and one
  in `ai/prompts/`. Tomorrow's "B6: prompt feedback ratchet" or
  "B7: tool-call provider" will keep stuffing the flat directory.
- **Recommendation**: Re-shape to:
  ```
  src/lib/ai/
    providers/         ← codex-*, openai-*, anthropic-*, local-*, mock-*
    runtime/           ← provider.ts (resolve), provider-chain.ts,
                          provider-runner.ts, generate-insight.ts
    schema/            ← schema.ts, types.ts (after merge — see M5)
    domain/            ← confidence.ts, citation-coverage.ts,
                          legacy-payload.ts, feedback-attribution.ts,
                          medical-references.ts
    prompts/           ← unchanged
  ```
  This is a mechanical rename + import-rewrite pass that the test
  suite will catch in seconds. The named-slot pattern in
  `<RecommendationCard>` proved the codebase responds well to
  thoughtful structural splits; the AI module needs the same
  treatment before v1.4.17 / v1.5 add another bucket.
- **Ship-blocker?**: no. v1.4.17 housekeeping.

### H2 — `src/components/insights/insight-advisor-card.tsx` (690 lines) has become a god-component carrying 4 inline sub-components, 3 lookup tables, the legacy-payload CTA, the data-quality drawer, and the recommendations grid wrapping

- **File**: `/Users/marc/Projects/HealthLog/src/components/insights/insight-advisor-card.tsx`
  (690 lines, was 582 in v1.4.15 — +108 from B5c legacy-payload CTA
  + B1b summary mini-charts + recommendations-grid wrapping)
- **Issue**: Single client module hosts:
  - `<HeroFinding>` (~60 lines, severity-tinted top-finding card)
  - `<InlineCharts>` (~50 lines, chart-token expander)
  - `<SectionSeparator>` (~15 lines, plus a duplicated comment header
    "Section Separator" appearing twice in the file at lines 284 and
    286 — copy-paste residue)
  - `<AssessmentIcon>` (icon switcher)
  - 4 module-scope lookup tables (`CLASSIFICATION_STYLES`,
    `HERO_STYLES`, `CONFIDENCE_STYLES`, `INLINE_CHART_TITLE_KEYS`,
    `CONFIDENCE_LABEL_KEYS`)
  - The main `<InsightAdvisorCard>` with loading / empty / error /
    full branches plus the legacy-payload CTA banner plus the
    data-quality collapsible drawer
  When the next phase (e.g. B5f or v1.4.17 comparison-callout)
  needs to add a UI block, the only natural insertion point is more
  inline JSX inside this file. The component already has 5 separate
  concerns; the named-slot discipline that worked for
  `<RecommendationCard>` was NOT applied here.
- **Recommendation**: Extract:
  - `src/components/insights/_advisor/hero-finding.tsx` — `<HeroFinding>` + `HERO_STYLES` + `<AssessmentIcon>`
  - `src/components/insights/_advisor/inline-charts.tsx` — `<InlineCharts>` + the title-keys map
  - `src/components/insights/_advisor/data-quality-drawer.tsx` — collapsible block
  - `src/components/insights/_advisor/legacy-payload-cta.tsx` — banner
  - `<InsightAdvisorCard>` becomes a slim composer (~150 lines) that
    just orchestrates loading/empty/error and delegates to the
    extracted blocks. Mirror the `<AdminShell>` per-section split
    that v1.4.15 phase B4 already established as the codebase
    pattern.
  Remove the duplicate `// ─── Section Separator ───` comment block.
- **Ship-blocker?**: no. v1.4.17 housekeeping.

### H3 — `src/components/insights/recommendation-card.tsx` (417 lines) is approaching the size where the named-slot pattern alone won't scale — 5-bucket plug-in pressure now bears on `<RationaleCard>`'s prop list (6 props, plus 5 derived feedbackProps)

- **File**: `/Users/marc/Projects/HealthLog/src/components/insights/recommendation-card.tsx`
- **Issue**: The named-slot architecture (`data-slot="rec-confidence-slot"`,
  `data-slot="rec-feedback-slot"`) was the right call in B5c — five
  buckets plugged in across B5c/d/e without merge conflicts. But the
  result is now a 417-line file where:
  - `RationaleCard` takes 6 props (`rationale`, `metricSource`,
    `referenceId`, `confidence`, `locale`, `feedbackProps`)
  - `feedbackProps` itself is a 5-field object built inline at the
    parent level via `asFeedbackTimeRange()` defence-in-depth
  - Three local helpers (`metricTypeToChartTypes`,
    `isMoodMetric`, `isComplianceMetric`) duplicate vocabulary that
    already lives in `src/components/charts/mini-window.ts` and
    `src/lib/insights/chart-tokens.ts`
  - `<CitationFootnote>` is defined inline AND consumed twice
    (expanded rationale + non-expandable legacy fallback)
  The component is still readable today, but the next bucket (e.g.
  B5f data-export-per-rec, or a v1.4.17 "share rec" affordance)
  will push it past 500 lines.
- **Recommendation**:
  - Extract `metricTypeToChartTypes` + `isMoodMetric` +
    `isComplianceMetric` to `src/lib/insights/rec-metric-routing.ts`
    (5-line file, but turns three duplicated `.toLowerCase()`
    branches into a single source of truth shared with
    `<InlineCharts>`).
  - Extract `<CitationFootnote>` to
    `src/components/insights/citation-footnote.tsx` — already used
    twice, no reason to keep it inline.
  - Extract `<RationaleCard>` to
    `src/components/insights/recommendation-rationale-card.tsx` —
    that's the natural split point, and it lets the prop list shrink
    by hiding the 5 feedback fields behind a single `rec` parameter.
  - Keep `asFeedbackTimeRange()` next to where it's used — it's
    defence-in-depth for the API contract, not a candidate for
    extraction.
  After this split `recommendation-card.tsx` drops to ~250 lines and
  the named-slot pattern keeps working for the next bucket.
- **Ship-blocker?**: no. Pre-emptive split for v1.4.17.

---

## MEDIUM

### M1 — `src/lib/ai/provider-runner.ts` carries TWO near-identical fallback runners (`runWithFallback` + `runRawCompletionWithFallback`) with a "v1.4.17 will delete the legacy variant" comment — premature abstraction OR live-bridge debt

- **File**: `/Users/marc/Projects/HealthLog/src/lib/ai/provider-runner.ts`
  lines 229-371 (143-line duplication)
- **Issue**: Two parallel async functions that differ only in the
  inner call site (`generateInsight()` vs
  `provider.generateCompletion()`). Both run the same chain
  walkthrough, both classify hard failures the same way, both reach
  for the same `applyLastWorkingCache` + `summariseError` helpers,
  both emit the same Wide-Event annotations. The comment at line 296
  says "v1.4.17 will migrate this route to the strict wrapper… at
  that point this helper is removed." If that's true, the duplication
  is a one-cycle bridge — fine. If v1.4.17 slips, the duplication
  doubles every fallback-policy change.
- **Recommendation**: Either:
  - **Inline-extract the chain walker** into a generic
    `runChain<T>(chain, attempt)` higher-order function and call it
    from both wrappers (~40-line reduction). Today.
  - OR commit to the v1.4.17 deletion as a calendar item and add a
    `// REMOVE: v1.4.17` marker the cleanup phase can grep for.
  Without one of those, the duplication will outlive its rationale.

### M2 — `<RecommendationFeedback>` reaches into `useAuth()` directly to scope the localStorage cache key; this couples a presentational rec-card slot to the auth subsystem

- **File**: `/Users/marc/Projects/HealthLog/src/components/insights/recommendation-feedback.tsx`
  lines 33, 134, 137-154
- **Issue**: The component takes a 5-field props bag describing the
  rec, then ALSO reaches into `useAuth()` to obtain `user.id` for
  the localStorage cache key. The localStorage scoping by user id is
  correct (a tour-launcher fix from H4 in v1.4.15 catch-up did the
  same thing for the same reason), but the feedback button is a
  "given a rec, render thumbs" leaf — it shouldn't know about auth.
  The hydration race the component handles in render
  (`hydratedFor !== user.id` — `setState` during render to dodge the
  `react-hooks/set-state-in-effect` lint) is a 17-line dance to
  satisfy a contract that could be `userId: string` on the props.
- **Recommendation**: Have the parent `<RecommendationCard>` pull
  `user.id` from `useAuth()` once and pass it as `userId` into
  `feedbackProps`. The feedback component drops to a pure
  function-of-props leaf: simpler render, no more hydration dance,
  one less hook call per rendered card. The `useMutation` call
  stays — that's behaviour, not auth.

### M3 — `src/lib/ai/types.ts` (132 lines) and `src/lib/ai/schema.ts` (329 lines) STILL define two response shapes; v1.4.15 M6 flagged this and v1.4.16 added rationale + confidence to BOTH instead of finishing the migration

- **Files**: `src/lib/ai/types.ts`, `src/lib/ai/schema.ts`
- **Issue**: Last milestone's senior-dev review M6 called the
  dual-schema state architectural smell. v1.4.16 doubled down:
  - `aiRecommendationRationaleSchema` (schema.ts) AND
    `insightRecommendationRationaleSchema` (types.ts)
  - `aiRecommendationSchema.confidence` AND
    `insightRecommendationSchema.confidence`
  - `metricSource` defined twice with subtly different field
    requirements (`schema.ts` requires `summary` non-empty;
    `types.ts` makes it required-but-permissive)
  Each duplicate field has comments saying "mirrors the strict
  schema in schema.ts" but there's no enforcement that they actually
  do — drift between the two would only show up when a cached
  payload deserialises differently between the two parsers.
- **Recommendation**: Bite the migration. v1.4.17 must either:
  - **Delete `insightResultSchema`** entirely; renderer migrates to
    consume `AIInsightResponse` directly (the .passthrough() shape
    already accepts both for cached payload back-compat).
  - OR explicitly define `InsightResult = AIInsightResponse & {
    classification, findings, ... }` in types.ts as an extension of
    the canonical schema — single source of truth, types.ts becomes
    the dashboard-renderer-specific projection.
  Carrying two schemas through another milestone risks a real
  divergence bug.

### M4 — `src/components/insights/recommendation-card.tsx`'s `metricTypeToChartTypes()` and `<InlineCharts>` in `insight-advisor-card.tsx` both maintain their own metric-type vocabulary; no shared source

- **Files**: `src/components/insights/recommendation-card.tsx`
  lines 114-135, `src/components/insights/insight-advisor-card.tsx`
  lines 216-230
- **Issue**: Two parallel mappings:
  - `metricTypeToChartTypes()` maps lowercased snapshot keys
    ("bloodpressure", "weight", "bodyfat", …) to the
    measurement-type enum strings.
  - `INLINE_CHART_TITLE_KEYS` maps measurement-type enum strings
    ("WEIGHT", "BLOOD_PRESSURE_SYS", …) to i18n title keys.
  Both grew with the same v1.4.16 phase. A future "add SLEEP_QUALITY
  metric" requires editing both files, with no compile-time guard
  that they stayed in sync.
- **Recommendation**: Extract one
  `src/lib/insights/metric-vocab.ts` exposing
  `MEASUREMENT_TYPES_BY_SNAPSHOT_KEY` + `MEASUREMENT_TITLE_KEYS_BY_TYPE`
  + helper `resolveMetricRoute(snapshotKey)`. Both consumers
  import. Adds one file, eliminates a hidden coupling.

### M5 — `<RationaleCard>` takes 6 props that come from the same rec; pass the `rec` (or normalised `NormalisedRec`) instead

- **File**: `src/components/insights/recommendation-card.tsx`
  lines 192-279, 396-402
- **Issue**: The `<RationaleCard>` callsite in
  `<RecommendationCard>` reads:
  ```tsx
  <RationaleCard
    rationale={norm.rationale}
    metricSource={norm.metricSource}
    referenceId={norm.referenceId}
    confidence={norm.confidence}
    locale={locale}
    feedbackProps={feedbackProps}
  />
  ```
  Five of those six props are de-structurings of `norm`. The prop
  list will only grow as future buckets plug in. Compare with
  `<RecommendationFeedback>` which already takes a rec-shaped props
  object.
- **Recommendation**: `<RationaleCard rec={norm} feedbackProps={feedbackProps} locale={locale} />`.
  Keeps `feedbackProps` separate (it's not a rec field — it's a
  derived "is the rec submittable for feedback?" gate) and `locale`
  separate (it's a user-context read). The prop list compresses to
  the two values that aren't already in `norm`.

### M6 — `i18n.insights.recommendation.*` namespace mixes 4 unrelated feature buckets at the same depth; B5e key naming `feedbackThanks` / `feedbackHelpful` / `feedbackAlreadyRated` is flat where rationale + confidence are also flat

- **File**: `messages/en.json` lines 701-722 (and `messages/de.json`
  mirror)
- **Issue**: Under the single `insights.recommendation.*` namespace
  live four sub-buckets:
  - source / viewSource (B5a citation)
  - rationale / rationaleWindow / rationaleComparedTo /
    rationaleDeviation / rationaleExpand / rationaleCollapse (B5c)
  - confidence / confidenceAria / confidenceHigh / confidenceMedium
    / confidenceLow / confidenceDraft (B5d)
  - feedbackHelpful / feedbackNotHelpful / feedbackThanks /
    feedbackConfirmed / feedbackAlreadyRated (B5e)
  - legacyPayloadCta (B5c)
  Five flat bullets sit alongside two nested-by-prefix groups. A
  future contributor will add `feedbackXyz` and not know whether
  to nest under `feedback: { … }` or stay flat. The codebase
  convention (verified against `messages/en.json` line 1558 admin
  scope: `hostMetrics: { title, load1, ... }` and 1569
  `aiQuality: { title, loading, ... }`) is **nested objects per
  feature bucket**.
- **Recommendation**: Re-shape to:
  ```json
  "recommendation": {
    "citation": { "source": "...", "viewSource": "..." },
    "rationale": { "window": "...", "comparedTo": "...", "deviation": "...",
                   "expand": "...", "collapse": "..." },
    "confidence": { "aria": "...", "high": "...", "medium": "...",
                    "low": "...", "draft": "..." },
    "feedback": { "helpful": "...", "notHelpful": "...", "thanks": "...",
                  "confirmed": "...", "alreadyRated": "..." },
    "legacyPayloadCta": "..."
  }
  ```
  Every consumer file gets a single-line `t()` rename;
  `messages/de.json` mirrors. The existing
  `sections-i18n-parity.test.ts` will catch any miss. The same
  shape already works for `admin.hostMetrics` / `admin.aiQuality` /
  `comparison.captionLastMonth` — apply consistently.

### M7 — `src/lib/ai/feedback-attribution.ts` reads the LATEST `insights.generate` audit row to attribute provider; this couples the feedback domain to the audit-log shape

- **File**: `src/lib/ai/feedback-attribution.ts` lines 70-86
- **Issue**: The function fetches the user's most recent
  `auditLog` row with `action: "insights.generate"`, parses the
  `details` JSON, and pulls `chainProviderType` (or fallback
  `providerType`). The audit log is a structured-event export
  surface — using it as the de-facto "what provider did the user
  most recently use" is a coupling that won't survive an audit-log
  schema change. The right home for "current active provider per
  user" is either:
  - a memoised read off `User.aiProviderChain` + the in-process
    runner cache (`getLastWorkingProvider()`)
  - or a dedicated `User.lastUsedProviderType` column written by the
    runner
  - or a dedicated AppSetting / cache table
- **Recommendation**: For v1.4.17, write the working provider into
  a per-user cache column at the END of `runWithFallback()` (the
  in-process cache already exists; the row is a 1-line schema
  add). The audit-log scan stays as a fallback for users whose
  cache hasn't been hydrated yet, but the primary read is from a
  dedicated column. As-is the feedback aggregator's slice is at the
  mercy of the audit-log retention policy.

### M8 — `src/lib/jobs/feedback-aggregator.ts`'s `buildFeedbackBuckets()` joins keys with empty separator (`[severity, metricSourceType, providerType, promptVersion].join("")`); two values "ab" + "cd" collide with one value "abcd"

- **File**: `src/lib/jobs/feedback-aggregator.ts` line 75
  ```ts
  const key = [
    row.recommendationSeverity,
    row.metricSourceType,
    row.providerType,
    row.promptVersion,
  ].join("");
  ```
- **Issue**: Empty-string join means `["bp","weight","openai","4.16"]`
  and `["bpweight","openai","","4.16"]` both produce `"bpweightopenai4.16"`.
  Today the inputs are constrained enough (severity is enum,
  providerType is enum, promptVersion is `4.16.0` with dots) that
  collision is unlikely. But the schema change that adds a hyphen-
  containing severity tomorrow could silently merge buckets.
- **Recommendation**: Use a delimiter that can't appear in any of
  the four values — convention in this codebase is `::` (see
  `findUncitedRecommendations` line 310 in `schema.ts`). One-char
  fix; eliminates a class of silent-collision bugs the test
  fixtures wouldn't catch.

### M9 — `<HostMetricsChart>`, `<AppLogPreviewSection>`, `<AiQualitySection>` follow a TanStack Query pattern with inline `(await res.json()).data` unwrap; the TanStack-collision memory note from v1.4.15 says the convention is the unwrap, but the new admin sections re-implement it three times instead of using a shared `fetchJsonOrThrow` helper

- **Files**: `src/components/admin/host-metrics-chart.tsx`,
  `src/components/admin/app-log-preview-section.tsx`,
  `src/components/admin/ai-quality-section.tsx`,
  `src/components/admin/api-token-overview-section.tsx`,
  `src/components/admin/backups-section.tsx`
- **Issue**: Five admin sections (and many more outside admin) all
  hand-roll the same `fetch + res.ok + json.data ?? throw` mini
  state machine. The error message is different in each
  ("ai_quality_failed" vs "Failed to load app logs" vs "Failed").
  No shared helper means error formatting drifts.
- **Recommendation**: One small `src/lib/api-client.ts` helper:
  ```ts
  export async function fetchJsonOrThrow<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
    const res = await fetch(input, init);
    const body = (await res.json()) as { data: T; error?: string };
    if (!res.ok) throw new Error(body.error ?? `Request failed: ${res.status}`);
    return body.data;
  }
  ```
  Adoption is opportunistic; not a structural requirement, but a
  natural cleanup pass. Already partially done: the existing
  `getApiErrorMessage` helper in `backups-section.tsx` is similar.
  Promote it.

---

## LOW

### L1 — `src/components/insights/insight-advisor-card.tsx` lines 284-286 has a duplicated `// ─── Section Separator ───` comment header

- **File**: `src/components/insights/insight-advisor-card.tsx`
- **Issue**: Two consecutive `// ─── Section Separator ───`
  comment headers, no code between them. Copy-paste residue from a
  marathon edit.
- **Recommendation**: Delete the duplicate. One-line fix.

### L2 — `<RecommendationFeedback>`'s 17-line `if (!initialState && user && hydratedFor !== user.id)` block in render-time is a workaround for `react-hooks/set-state-in-effect` that future readers will trip over

- **File**: `src/components/insights/recommendation-feedback.tsx`
  lines 137-154
- **Issue**: The set-state-during-render dance is correct (matches
  the lazy-init pattern documented in CLAUDE.md), but the block has
  no comment explaining why it's not in `useEffect`. A code reviewer
  unfamiliar with the project rule would flag it as a bug.
- **Recommendation**: One-line comment: `// CLAUDE.md rule: avoid setState in useEffect; recompute from props during render is the project pattern (matches tour-launcher.tsx).`

### L3 — `src/lib/ai/provider-chain.ts` and `src/lib/ai/provider.ts` both reference a `ProviderChainResolved` type; the type is defined in `provider-runner.ts` (the most-imported file) but the comment at provider-chain.ts top says "Why a separate module rather than inlining"

- **File**: `src/lib/ai/provider-chain.ts` lines 12-19
- **Issue**: `ProviderChainResolved` is the bridge type
  (logical-type + instance) that both `provider-chain.ts` (parser)
  and `provider-runner.ts` (executor) need. It's defined in
  `provider-runner.ts` and re-imported by `provider.ts` — backwards
  layering. The parser layer should own the type; the runner
  consumes it. Today's layout means `provider-chain.ts` doesn't
  know about it (it stops at metadata) and `provider.ts` imports
  from `provider-runner.ts` for a type the runner doesn't author.
- **Recommendation**: When H1's directory restructure happens, move
  `ProviderChainResolved` into `runtime/provider-chain.ts` (or a new
  `runtime/types.ts`), so the parser can name what the runner
  consumes. Trivial; do as part of the H1 split.

### L4 — `src/lib/ai/legacy-payload.ts` (55 lines) is a one-function module that could live in `schema.ts` next to `findRecommendationsMissingRationale()`

- **File**: `src/lib/ai/legacy-payload.ts`
- **Issue**: `isLegacyInsightPayload(payload: unknown): boolean` is
  the only export. `schema.ts` already exports
  `findRecommendationsMissingRationale(parsed: AIInsightResponse)`
  for nearly the same legacy-detection use case. Two helpers, two
  modules, same domain.
- **Recommendation**: Inline into `schema.ts` (or a new
  `schema/legacy-detection.ts` after H1's split). Watch for the
  type difference: `isLegacyInsightPayload` takes `unknown`,
  `findRecommendationsMissingRationale` takes `AIInsightResponse` —
  they cover different stages of the parse pipeline. Document the
  staging in the merge.

### L5 — `<RecommendationCard>`'s `LOW_CONFIDENCE_CAPTION_THRESHOLD = 50` and `<ConfidenceMeter>`'s `DRAFT_THRESHOLD = 25` + 80 / 50 / 25 band cuts live in two separate files with no shared source

- **Files**: `src/components/insights/recommendation-card.tsx`
  line 102, `src/components/insights/confidence-meter.tsx` line 37
- **Issue**: The confidence thresholds are split:
  - `<ConfidenceMeter>`: 80 (high), 50 (medium), 25 (low/draft)
  - `<RecommendationCard>`: 50 (low-confidence-caption)
  - `src/lib/ai/confidence.ts`: no constants exposed (formula-only)
  Three files, three sets of magic numbers. A future "tighten the
  band cutoffs" change requires editing three places.
- **Recommendation**: Add a `src/lib/ai/confidence-bands.ts`
  exposing:
  ```ts
  export const CONFIDENCE_BANDS = {
    DRAFT: 25,
    LOW: 50,
    MEDIUM: 80,
  } as const;
  ```
  Both components import. The threshold semantics become
  self-documenting (`< CONFIDENCE_BANDS.LOW` reads better than
  `< 50`).

### L6 — `src/lib/jobs/host-metric-sampler.ts`'s `getHostMetricRetentionDays()` reads env on every call; no caching, no obvious test reason

- **File**: `src/lib/jobs/host-metric-sampler.ts` lines 120-131
- **Issue**: Every minute the worker fires `runHostMetricTick()`
  which calls `getHostMetricRetentionDays()` which calls
  `process.env.HOST_METRIC_RETENTION_DAYS`. Cheap call, but the
  pattern is inconsistent with the rest of the codebase. v1.4.15
  M8 already flagged the parallel "lazy env vs frozen env" split
  in integrations vs notifications; this adds a third site.
- **Recommendation**: Defer to the M8/L1 v1.4.17 cleanup that picks
  one canonical pattern.

### L7 — `prisma/schema.prisma` the new `RecommendationFeedback` model uses `recommendationSeverity` / `recommendationText` (camel) but `metric_source_type` / `metric_source_time_range` (snake-via-@map); the JS-side names are camelCase but the db column names mix prefixed-with-feature and not

- **Files**: `prisma/schema.prisma` lines 833-840
- **Issue**: The model uses `recommendationSeverity` (prefixed with
  feature noun) and `metricSourceType` (prefixed with feature noun
  too — but on-the-wire and in the table). This is consistent with
  the rest of the schema. But the v1.4.16 audit-log query uses
  `actor` / `action` / `target` as filter keys; the
  recommendation-feedback row uses `recommendationId` /
  `recommendationText` / `recommendationSeverity` — the
  feature-prefix scheme is verbose where context already pins the
  feature. The same row could read cleaner as `id`, `text`,
  `severity` (the model name already says it's recommendation
  feedback).
- **Recommendation**: Cosmetic only — the prefixed naming is
  defensible (the model is also the join target so prefixed names
  read clearly under join queries). Flag for the v1.4.17 settings
  audit (B6 follow-up) only if Marc has a feel-preference.

### L8 — `src/lib/ai/medical-references.ts` and `<CitationFootnote>` both render the citation label as `{org} {publishedYear} — {title}` — the format is duplicated rather than centralised in a `formatCitationLabel(ref, locale)` helper

- **Files**: `src/lib/ai/medical-references.ts`,
  `src/components/insights/recommendation-card.tsx` line 173
- **Issue**: One UI surface today; the v1.4.17 "share rec" or
  the doctor-report PDF would re-render the same citation in the
  same shape. No helper means a typography change requires editing
  two places.
- **Recommendation**: Add `formatCitationLabel(ref, locale)` to
  `medical-references.ts`. Today's only consumer is
  `<CitationFootnote>`; flagged here so the second consumer
  copy-pastes from the helper rather than the component.

### L9 — `src/lib/jobs/reminder-worker.ts` (1,350 lines) is the v1.4.16 +70-line addition (host-metric + feedback-aggregator queue registrations) on top of an already-too-large worker module

- **File**: `src/lib/jobs/reminder-worker.ts`
- **Issue**: 1,350 lines hosting reminder dispatch, insight caching,
  data-backup, host-metric sampling, feedback aggregation, queue
  registration, and the pg-boss instance. The file is the single
  entry point for every cron-style background job — no per-queue
  module split. Each new queue is +70 lines at the bottom of a
  huge file.
- **Recommendation**: v1.4.17 — split per queue under
  `src/lib/jobs/queues/<queue-name>.ts`, each exporting a
  `register(boss: PgBoss)` function. `reminder-worker.ts` becomes
  a 50-line orchestrator that calls each `register()`. The host-
  metric and feedback-aggregator additions in v1.4.16 already have
  pure compute helpers split out (`host-metric-sampler.ts` /
  `feedback-aggregator.ts`); the missing piece is the queue-config
  + handler-wiring split. Mirror what v1.4.15 did for notifications
  (`src/lib/notifications/dispatcher.ts` orchestrates;
  per-channel senders in `src/lib/notifications/senders/`).

---

## Cross-cutting observations (positive)

- **Worktree adoption worked**: Last milestone's H3 (parallel-agent
  staging race) was the recurring complaint; v1.4.16 STATE.md
  records `agent/b1b-insights-surface`,
  `agent/b2-ai-provider-ux`, `agent/b5c-explainability`,
  `agent/b5d-confidence`, `agent/b5e-feedback-loop`,
  `agent/b6-settings-audit`, `agent/b8-comparison-views`,
  `agent/wave-c-catchup` — all worktree-isolated. Cross-agent
  collisions still happen (`9b01c86` carries both A6 and A7
  files; `8d9f864` absorbed B3 chart + i18n; `2611bb4` got
  hijacked by B1a's mood-chart) but the working tree on `main`
  is correct in every case. The "wrong commit subject" outcomes
  are diff-faithful, just message-misleading.
- **Named-slot pattern is a clear win**: `<RecommendationCard>`'s
  `data-slot="rec-confidence-slot"` + `data-slot="rec-feedback-slot"`
  let B5c, B5d, B5e ship in parallel without merge conflicts.
  The pattern should be the v1.4.17 default for any component
  that anticipates plug-in pressure.
- **Pure-function extraction is consistent**: B5d's `confidence.ts`
  exposes `computeConfidence(inputs)` as a pure function with
  unit tests; B8's `comparison-shift.ts` exposes
  `shiftDailySeriesForward()` + `computeComparisonDelta()` the
  same way; B5e's `feedback-aggregator.ts` exposes
  `buildFeedbackBuckets()` separately. This is the right pattern
  and the marathon used it consistently.
- **Test-architecture is correct**: `tests/integration/`
  testcontainers for the new `admin-host-metrics`,
  `insights-feedback`, `insights-provider-chain` /
  `insights-provider-chain-put`, `cascade-delete`,
  `export-per-type`. SSR component tests under `__tests__/`
  alongside the source files. Pure-function helpers tested in
  isolation. No mocks-test-themselves smells observed.
- **`apiHandler()` discipline holds**: every new API route
  (`/api/insights/feedback`, `/api/insights/provider-chain`,
  `/api/admin/host-metrics`, `/api/admin/audit-log`,
  `/api/admin/audit-log/actions`, `/api/admin/app-logs`,
  `/api/admin/ai-quality`, `/api/export/measurements`,
  `/api/export/medications`, `/api/export/mood`,
  `/api/export/full-backup`) wraps in `apiHandler` with
  `requireAuth()` or `requireAdmin()`.
- **`annotate()` adoption is universal**: 42 `annotate()` call
  sites in v1.4.16-touched non-test files; zero new `console.*`
  calls (the only `console.*` greps in `reminder-worker.ts`
  predate v1.4.16, and they're explicitly the pg-boss-error
  fallback the worker has used since v1.3).
- **`HttpError` discipline holds**: every new API-route throw
  that needs to escape `apiHandler` uses `HttpError` (verified:
  `provider-chain/route.ts:87,98`, `backups/[id]/restore/route.ts:126`).
  The other `throw new Error()` matches in the grep all live
  inside TanStack Query `mutationFn` / `queryFn` callbacks where
  the throw is internal to the React Query state machine.
- **Encryption discipline holds**: every new sensitive value goes
  through `decrypt()` from `crypto.ts` (verified at
  `provider.ts:59,67,84` for AI keys; nothing new in v1.4.16
  reached for raw cipher).
- **TODO/FIXME inventory**: zero. `git grep -nE "(TODO|FIXME|HACK|XXX)"`
  filtered to v1.4.16-changed files in `src/` returns no matches.
- **Comment quality**: comments paraphrase code in only one
  observed location (L2 above); the marathon's "WHY not WHAT"
  discipline shows.

The structural foundation continues to hold; the v1.4.16 findings
above are mostly "this could be cleaner before the next bucket
plugs in", not "this is wrong".

---

## Summary

- **0 CRITICAL** — nothing blocks v1.4.16 ship.
- **3 HIGH** — directory layout pressure on `src/lib/ai/` (H1),
  god-component drift in `<InsightAdvisorCard>` (H2), pre-emptive
  split for `<RecommendationCard>` before the next plug-in (H3).
- **9 MED/LOW** — premature-or-bridge duplication in the chain
  runner (M1), auth coupling in feedback leaf (M2), dual schema
  STILL not migrated from v1.4.15 (M3), shared metric-vocab
  duplication (M4), `<RationaleCard>` prop-list growth (M5), i18n
  namespace flattening drift (M6), audit-log coupling for feedback
  attribution (M7), bucket-key collision risk (M8), shared
  `fetchJsonOrThrow` opportunity (M9), plus seven LOW housekeeping
  items.

Recommended action: **ship v1.4.16**. File the three HIGH items
+ M3 (the carry-over from v1.4.15 M6) in the v1.4.17 backlog as
the AI-module restructure block. The MED/LOW items are
opportunistic; pick them up when adjacent code is touched.
