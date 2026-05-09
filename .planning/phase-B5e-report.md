# Phase B5e — User-feedback loop (v1.4.16)

Completed 2026-05-10 ~01:45 CEST.

Worktree-isolated under `agent/b5e-feedback-loop` so the parallel B5d
worker on `agent/b5d-confidence` couldn't bleed in. Six atomic
commits on origin/main, each TDD-first (failing test then fix).

## What landed

| # | Commit | What it ships |
|---|--------|---------------|
| 1 | `badc893 feat(db): RecommendationFeedback model with GDPR cascade + provider attribution` | Prisma model + migration `0034_recommendation_feedback`. `(userId, recommendationId, recommendationText)` unique constraint as the dedup key; `(userId, createdAt)` and `(severity, helpful, createdAt)` indexes for the per-user timeline + aggregator slice. Adds `AppSettings.adminAiInsightsFeedbackSummary Json?` for the daily aggregator's output. Cascade-delete integration test seeds + asserts a feedback row. |
| 2 | `8255e3e feat(api): /api/insights/feedback persists thumbs with provider attribution` | New `POST /api/insights/feedback` route: zod-validated body, `withIdempotency()` retry-replay, `requireAuth()` gate, server-fills providerType + promptVersion via `resolveFeedbackAttribution()` (reads latest `insights.generate` audit row, prefers chainProviderType > providerType > "unknown"). 201 on insert / 409 on dedup / 422 on validation. Audit row `insights.recommendation.feedback`. 7 schema tests + 5 attribution tests + 4 integration tests. |
| 3 | `ca84fb7 feat(insights): thumbs-up/down feedback component with optimistic updates` | `<RecommendationFeedback>` component — TanStack Query mutation, two icon buttons (thumb-up / thumb-down), state machine (default → submitting → submitted/already-rated/error). localStorage cache keyed `(userId, recId, truncatedRecText)`. Auth-resolution race handled via setState-during-render (not useEffect — honours `react-hooks/set-state-in-effect`). EN+DE i18n: 5 new keys under `insights.recommendation.{feedbackHelpful,feedbackNotHelpful,feedbackThanks,feedbackConfirmed,feedbackAlreadyRated}`. 6 component tests. |
| 4 | `47ca1e4 feat(insights): RecommendationCard renders feedback thumbs in named slot` | Fills the `data-slot="rec-feedback-slot"` reserved by B5c. Defence-in-depth `asFeedbackTimeRange()` + attribute completeness check leaves the slot empty for legacy/partial recs (no id, missing severity, out-of-vocabulary timeRange) so a thumbs-click can never produce a 422. 3 new rec-card tests + retrofit `useMutation` + `useAuth` mocks across the existing rec-card / advisor-card / integration test files. |
| 5 | `71ffe30 feat(jobs): daily feedback aggregator writes per-(severity x provider) summary to AppSettings` | New pg-boss `feedback-aggregator` queue running daily 04:00 Europe/Berlin (after the rate-limit / idempotency / audit-log cleanups). Pure `buildFeedbackBuckets()` helper for in-memory aggregation; `aggregateRecommendationFeedback()` does the Prisma round-trip + AppSettings upsert. Bucket sort is deterministic (severity → metricSourceType → provider → prompt). Worker handler degrades gracefully on failure (warn, don't throw). 5 unit tests cover bucketing + 2 aggregator scenarios. |
| 6 | `8879282 feat(admin): AI quality preview showing per-(severity x provider) helpful-rate` | New `/admin/ai-quality` route + `<AiQualitySection>` component reading `GET /api/admin/ai-quality` (admin-only). 7-column table tinted by severity + helpful-rate band (green ≥ 0.8 / yellow ≥ 0.5 / orange below). New `ai-quality` slug threaded through ADMIN_SECTION_SLUGS + admin-shell + dynamic [section] renderer. Empty-state copy distinguishes "no feedback yet" from "all-zeros". EN+DE i18n: 13 new keys (`admin.section.ai-quality.*` + `admin.aiQuality.*`). 5 dedicated component tests + 1 sections-smoke + 1 slug-parity test. |

## Verification

- `pnpm test` — 1464/1464 unit tests pass (was 1396 before B5e ramp;
  B5e contributes +20 net direct tests; the rest is B5d landing in
  parallel during the rebase window). 183 test files (was 175).
- `pnpm test:integration` — 59/59 integration tests pass (was 55
  before; +4 for `insights-feedback.test.ts` covering happy path,
  dedup-409, validation-422, and unknown-provider fallback).
- `pnpm typecheck` — 0 errors.
- `pnpm lint` — 12 pre-existing warnings / 0 errors.

## Architecture decisions worth surfacing

**Server-fills attribution** — the brief spec said "Server fills
providerType + promptVersion from the user's most recent cached
payload". `User.insightsCachedText` doesn't carry provider attribution
itself (it stores the AI response, not its provenance), so the
helper reads the latest `insights.generate` audit row whose `details`
JSON carries `chainProviderType` (B5b's runner) + `providerType`
(legacy fallback). PROMPT_VERSION snapshots the current constant.
This is correctly tamper-resistant — the client never supplies any
of these fields.

**Idempotency-cache safety** — the response body `{ id, createdAt }`
contains no secrets, so it's safely cacheable by `withIdempotency()`.
The `hlk_/hlr_/sk-` defence-in-depth filter in `idempotency.ts` is a
no-op for this endpoint; no extra wiring needed.

**Defence-in-depth at the rec-card slot** — `asFeedbackTimeRange()`
gates the slot on a four-window vocabulary so a future provider
that emits `metricSource.timeRange = "lastFortnight"` can't render
a thumbs-row that would 422 on submit. Same gate handles legacy
recs (no id, no severity) by leaving the slot DOM-stable but empty.

**Non-API-driven aggregator wiring** — the worker handler receives
a `Job<FeedbackAggregatorPayload>[]` but ignores the payload (cron-
scheduled). The `void jobs;` pattern matches every other cron-only
queue in this file (host-metric-sample, audit-log-cleanup, etc.).

**Admin route placement** — research §3.B suggested `/admin/ai-
quality` OR a slot inside `/admin/system-status`. Chose the dedicated
route per the brief's "your call" — system-status is already crowded
with the host-load chart, facts grid, and worker-status panel, and
the AI-quality table needs the full content width to surface 7
columns cleanly on mobile.

## Cross-agent race notes

The rebase before commit 6 brought in 7 commits from B5d (confidence
score + ConfidenceMeter component + low-confidence caption + rationale
schema confidence-required flip). B5d's edits to
`recommendation-card.tsx` extended the file in non-conflicting ways:
B5d added the `confidence` field to `NormalisedRec`, threaded it
through `<RationaleCard>`, and rendered `<ConfidenceMeter>` in
`data-slot="rec-confidence-slot"`. My commit 4 had filled
`data-slot="rec-feedback-slot"` and added `feedbackProps` threading.
The post-rebase diff shows both B5c slots populated by their owners
(B5d ConfidenceMeter, B5e RecommendationFeedback) with zero overlap
or conflict — exactly what the named-slot pattern was meant to
deliver. Zero collisions on commits 1, 2, 3, 5, 6.

## What v1.4.17 inherits

- **Aggregator output is the source of truth for prompt-tuning.**
  `AppSettings.adminAiInsightsFeedbackSummary.buckets` is the input
  the v1.4.17 ratchet reads to append per-bucket "OMIT" or "REPHRASE"
  rules to the system prompt. Schema is shipped; mutation is
  deferred.
- **Single-user-default-on policy honoured** — only Marc's ratings
  shape Marc's future prompts; cross-user aggregate is admin-only
  and surfaces only on `/admin/ai-quality`. No opt-out flag added in
  v1.4.16 (research §3 default-on stance).
- **Confidence ratchet hook is wired** — research §5.2 noted the
  aggregator's tunable threshold table will need
  `(severity x confidence_band)` slicing so low-confidence-and-low-
  helpful-rate buckets ratchet faster than high-confidence ones.
  `RecommendationFeedback` doesn't yet carry the confidence value
  (research §5.2 flagged adding a `recommendationConfidence Int?`
  column as cheap insurance — that's a v1.4.17 follow-up; the
  current schema migration is forward-compatible with adding it).

## Files touched

- prisma/schema.prisma + prisma/migrations/0034_recommendation_feedback/
- src/lib/validations/recommendation-feedback.ts (+ tests)
- src/lib/ai/feedback-attribution.ts (+ tests)
- src/app/api/insights/feedback/route.ts
- src/components/insights/recommendation-feedback.tsx (+ tests)
- src/components/insights/recommendation-card.tsx (slot fill)
- src/lib/jobs/feedback-aggregator.ts (+ tests)
- src/lib/jobs/reminder-worker.ts (queue + handler wiring)
- src/app/api/admin/ai-quality/route.ts
- src/components/admin/ai-quality-section.tsx (+ tests)
- src/components/admin/{section-slugs.ts,admin-shell.tsx}
- src/app/admin/[section]/renderer.tsx
- messages/{en,de}.json (+ 18 new keys total: 5 feedback + 13 admin)
- tests/integration/{cascade-delete,insights-feedback}.test.ts
