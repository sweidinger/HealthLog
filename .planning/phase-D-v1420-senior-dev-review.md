# Phase D — Senior-dev review (v1.4.20)

Reviewed against `develop` HEAD `ded0b38` (27 commits, ~+15 kLOC across 94 files). Focus: architectural posture rather than line-level nitpicks. Cross-references the parallel `phase-D-v1420-code-review.md` (line-bug catalogue) and `phase-D-v1420-security-review.md` only where the architectural issue is distinct.

## Summary

Architectural posture: solid, with one structural fault that will outlive the release if not addressed. The Coach surface is the most disciplined slice of new code in the repo: clear module boundaries (`types.ts` / `persistence.ts` / `budget.ts` / `refusal.ts` / `snapshot.ts` / `system-prompt.ts`), label-only provenance separated from encrypted bodies, AES-GCM at rest with key-id stamping for rotation, prompt-injection regex bank, per-day token ledger keyed on UTC, and 404-not-403 ownership semantics. The Insights surface (correlations, health score, weekly report, storyboard annotations) is wired through the existing AI provider chain and the existing schema-lift pattern in `useInsightsAdvisorQuery` — no new infrastructure invented where existing primitives fit. Where it falls down: a duplicated maths layer (`src/lib/insights/correlations.ts` parallels the older `src/lib/analytics/correlations.ts` + `analytics/health-score.ts` re-implements `linearRegressionSlope` next to `analytics/trends.ts:trendSlope`), a fragile SSE-vs-idempotency interaction that the streaming hook silently papers over, and an `extractFeatures()` re-fetch on every Coach turn that does not scale. Findings: 0 CRITICAL · 4 HIGH · 6 MED · 4 LOW.

## CRITICAL

_None._ (One borderline-CRITICAL — Coach SSE inside `withIdempotency` — captured as HIGH-1 because the streaming hook short-circuits before the bug becomes user-visible. The dead path is still wrong.)

## HIGH

### SD-HIGH-1 — `withIdempotency` wraps a streaming response and silently mis-caches it

**File**: `src/app/api/insights/chat/route.ts:429-450`, `src/lib/idempotency.ts:218-242`

**What**: New-conversation POSTs to `/api/insights/chat` go through `withIdempotency(handleChatRequest)`. The handler returns a `Response` whose body is a `ReadableStream<Uint8Array>` of `data: …\n\n` SSE frames with `status: 200` (cachable per `isCachableStatus`). The wrapper then runs `response.clone().text()` to scan for `hlk_/sk-` secrets and persists the body verbatim into `idempotency_keys.responseBody`. On replay, `findCached()` does `JSON.parse(row.responseBody)` (the SSE text isn't JSON, parse fails silently to `null`) and returns `NextResponse.json(null, { status: 200 })`. A retry under the same `Idempotency-Key` would therefore deliver `null` instead of the original conversation — but the user never sees it because the streaming client (`use-coach.ts:267-302`) uses `fetch` without `Idempotency-Key`, so the wrapper never fires from the PWA. The iOS app, which DOES set `Idempotency-Key` per the codebase convention (`hlk_` regex), would walk straight into this on first retry.

**Why architectural**: SSE bodies do not survive the request/response idempotency model the rest of the API uses. The cache layer assumes JSON-serialisable envelopes; bolting a stream onto it without a guard is the kind of cross-cutting mismatch that makes a future maintainer wrong by default. There's also no integration test exercising `Idempotency-Key` against the SSE route — the gap is invisible in CI.

**Fix or refactor**: Either (a) skip idempotency caching whenever `Content-Type` starts with `text/event-stream` (one-line guard in `withIdempotency` next to the secret-pattern check), or (b) split the SSE-emitting code-path off the idempotency wrap entirely — only cache the conversation-creation side-effect (return a JSON 201 with the new `conversationId`) and have the client open the SSE on a subsequent request. Option (a) is a 5-minute fix; option (b) is correctness-superior and trims the per-stream cost of holding the entire reply in memory before the first byte goes out.

### SD-HIGH-2 — Duplicated maths layer: `pearson` × 2, `linearRegressionSlope` × 2

**Files**:

- `src/lib/insights/correlations.ts:107` — new `pearson()` (with p-value, Fisher CI, t-stat).
- `src/lib/analytics/correlations.ts:77` — existing `pearsonCorrelation()` (used in `weight-status`, `blood-pressure-status`, `mood-status`, `features.ts` — five callers).
- `src/lib/analytics/health-score.ts:81` — new `linearRegressionSlope()`.
- `src/lib/analytics/trends.ts:111` — existing `trendSlope()` (consumed by every `summarize()` call across analytics).

**What**: v1.4.20 added a second Pearson implementation and a second least-squares slope, both pure, both correct, neither aware of the other. The strategic-plan rationale (`phase-B3-report.md`) explains the new `pearson` carries a p-value + CI that the old one lacks — a real reason to add columns to the contract — but the right move is to extend the existing helper with optional p-value + CI fields and use ONE function across the codebase. As of v1.4.20 a maintainer hunting "where do we compute Pearson?" finds two answers, with subtly different return shapes (`{r, strength, n}` vs `{r, n, pValue, confidenceInterval}`) and different `minPairs` defaults (5 vs 14).

**Why architectural**: Two parallel implementations of the same identity (Pearson r) is a textbook drift hazard. The version with German strength labels (`stark/moderat/schwach/keine`) lives in `analytics/`, the version with English UI bands (`low/moderate/high`) lives in `insights/`. A v1.4.21 author who patches one will not know about the other. Same for the slope helper — `trendSlope()` and `linearRegressionSlope()` differ in date handling (Date object vs ISO-string sort) and one returns `null` for fewer-than-2 points while the other returns `null` for fewer-than-2 distinct x-values.

**Fix or refactor**: Consolidate into a single `src/lib/analytics/correlation.ts` (singular) and `src/lib/analytics/regression.ts`. Add the p-value + CI fields as optional outputs on the existing `pearsonCorrelation()`. Migrate insights/correlations.ts callers (`correlateBpCompliance`, `correlateMoodPulse`, `correlateWeightWeekday`) to import from analytics. The hypothesis-specific runners (which do the `n>=14`/`p<0.05` gating + interpretation strings) keep living in `lib/insights/` because they ARE feature-specific.

### SD-HIGH-3 — `buildCoachSnapshot` re-extracts the entire user history on every Coach turn

**File**: `src/lib/ai/coach/snapshot.ts:30-32` → `src/lib/insights/features.ts:272`.

**What**: Every POST to `/api/insights/chat` calls `extractFeatures(userId, false)`, which runs `prisma.measurement.findMany({ where: { userId } })` with NO date filter — fetching every measurement the user has ever recorded. For Marc's data set (572 paired BP rows + weight + pulse + mood + glucose) that's a few hundred rows; for an external-ingest power user with multiple years of Withings data it's tens of thousands. Compounded with the 18-turn-window prompt assembly, every Coach turn pays full historical I/O.

**Why architectural**: The Coach is conceptually a chat over the same snapshot the dashboard renders — but the snapshot is regenerated from raw measurements per turn instead of cached. The strategic plan called this out as "Reuses the analytics features pipeline so the Coach narrates the exact same numbers" which is right architecturally — except the analytics pipeline is itself uncached. There's no `react-query`-style server-side memo, no Redis layer, no `pg_boss` job to pre-compute the snapshot once per day. v1.4.21 will not be able to scale this without a snapshot-cache abstraction.

**Fix or refactor**: Extract a `buildSnapshotForUser(userId, locale)` helper that lives in `src/lib/ai/snapshot/` and is used by BOTH the Coach (per turn) and the existing insight-generator route. Cache it by `(userId, last-measurement-mtime)` for 60s either in-process (Map+TTL) or via a `snapshot_cache` Prisma model keyed on `userId` with a `staleAfter` column. v1.5 can add a pg-boss `snapshot.refresh` job. Even a 60-second in-memory cache eliminates the steady-state re-fetch when a user is mid-conversation.

### SD-HIGH-4 — `<CoachDrawer key={coachPrefill ?? "blank"}>` weaponises React keys for state reset

**File**: `src/app/insights/page.tsx:1611-1616`, `src/components/insights/coach-panel/coach-drawer.tsx:88-89`.

**What**: The page re-keys `<CoachDrawer>` on every prefill change so the drawer's lazy-init `useState<string>(() => prefill ?? "")` reads the latest chip text. Side-effects: any in-flight stream is torn down, the conversation cache for the current thread is dropped, the message thread re-renders from scratch, and the rail's confirm-delete state is lost. A user who picks a chip mid-stream loses the stream. The `useEffect`-set-state-in-effect lint avoidance was the trigger (per inline comment), but the chosen workaround is heavier than the problem.

**Why architectural**: Using `key=` to reset child state is a code smell — it bypasses the component's own state contract. The drawer should expose a `setPrefill(value: string)` method (or, more idiomatic, accept `prefill` as a controlled prop and own no internal copy of it). The current shape leaks the parent's "I changed the prefill" intent into a React key, which is the wrong API.

**Fix or refactor**: Make `prefill` a fully-controlled prop on `<CoachDrawer>`. The drawer reads it directly into the textarea's `value=` and notifies up via `onPrefillConsumed` after the user submits. Drop the `key=` re-mount. This composes naturally with the in-flight stream — picking a new chip stages the next message instead of nuking the current one.

## MED

### SD-MED-1 — Coach tables not covered by `cascade-delete.test.ts` despite the migration claiming so

**File**: `prisma/migrations/0035_coach_conversations_v1420/migration.sql:18` says "GDPR: every table cascades on user delete via FK chains, covered end-to-end in tests/integration/cascade-delete.test.ts." Searching that test for `coach`, `CoachConversation`, `coach_messages`, `coach_usage` returns zero hits. The cascade IS configured at the SQL level (verified in the migration), but the integration test pinning that contract was never updated.

**Why architectural**: The integration suite is the GDPR firewall. A future schema change that accidentally drops a cascade rule would not be caught in CI. The comment is also a documentation lie that future maintainers will trust.

**Fix**: Add three `expect(...count(...)).toBe(0)` lines to `cascade-delete.test.ts` for `coachConversation`, `coachMessage`, `coachUsage` — five-line patch.

### SD-MED-2 — `weeklyReport` + `storyboardAnnotations` lifted off cache without `safeParse`

**File**: `src/components/insights/use-insights-advisor.ts:71-99` schema-validates `dailyBriefing` and `trendAnnotations` via `.safeParse`. `src/components/insights/weekly-report-view.tsx:57-58` and `src/app/insights/page.tsx:921-929` cast directly: `(advisor.payload?.insights as { weeklyReport?: WeeklyReport })`. A stale cache from a buggy provider (or a future schema change) would crash the page or render malformed sections.

**Why architectural**: The advisor is the single point where AI payloads cross the trust boundary. The lift-pattern is the contract; two new blocks bypass it. Pick one approach.

**Fix**: Lift `weeklyReport` + `storyboardAnnotations` through `weeklyReportSchema.safeParse` and `storyboardAnnotationsSchema.safeParse` in `useInsightsAdvisorQuery`, the same way the other two blocks are.

### SD-MED-3 — No rate-limit on `/api/insights/chat`; only the 25k/day token cap

**File**: `src/app/api/insights/chat/route.ts:127-149` calls `enforceBudget()` (cap on `coach_usage.totalTokens`) but no `enforceRateLimit()` call. A malicious client can spam tiny "ok" messages — each consumes ~10 tokens but each runs encrypt+persist+provider-call. 1000 messages × few-second latency = ~1h provider-bill churn before the budget gate trips.

**Why architectural**: Every other auth-gated POST in the codebase that talks to a paid upstream (Withings sync, insights generate) goes through the in-memory rate-limiter. Coach is the highest-cost surface and skips it.

**Fix**: Wrap `handleChatRequest` in the existing `enforceRateLimit({ key: \`coach.chat:\${userId}\`, max: 30, windowMs: 60_000 })` (or matching budget). Roughly five lines.

### SD-MED-4 — Inline `tokeniseForStreaming` is fake-streaming and adds latency without value

**File**: `src/app/api/insights/chat/route.ts:89-95` and `:312-335`.

**What**: The route runs `runRawCompletionWithFallback()` to completion, gets the full reply text, then `tokeniseForStreaming(replyText)` re-splits it on whitespace and pushes each word as a separate SSE frame in the `start()` callback (synchronous, no flush boundary). The user sees a single network response with all frames buffered together — the streaming UX is theatrical.

**Why architectural**: The choice between "wait for full reply, then tokenise" and "true upstream streaming" is a real architectural decision (the providers' SDKs all support streaming), and v1.4.20 chose the former. That's defensible — schema validation needs the full body to parse, and the strict-schema path is the v1.4.15 hardening anchor — but the Coach replies are NOT schema-validated (they're free prose). There's no reason this surface couldn't pipe through to true streaming. The current shape is a UX claim that the engineering doesn't back.

**Fix or refactor**: Defer to v1.4.21 — wire `runRawCompletionWithFallback` to a streaming variant that yields chunks. The provider abstraction needs an `onToken` callback. This unlocks "stop generating" as a real feature later. For v1.4.20, document the choice in the route header so the next maintainer knows it's intentional.

### SD-MED-5 — `medication_schedules.days_of_week` schema drift surfaces in B5

**File**: `src/app/api/analytics/route.ts:394-407` deliberately uses `select: { schedules: { select: { windowStart: true, windowEnd: true } } }` to dodge the missing `days_of_week` column (per `phase-B5-report.md` flagged-uncertain item 1). The `src/app/api/insights/comprehensive/route.ts` route uses `include: { schedules: true }` and would crash on a fresh DB.

**Why architectural**: Codebase carries a half-applied schema migration. v1.4.20 worked around it locally; v1.4.21 will keep working around it locally; v1.5 will hit a fresh-DB build that breaks. This is the textbook tech-debt accrual the lens asks about.

**Fix**: Either (a) `pnpm db:migrate` produce the missing column with a backfill default, or (b) remove the field from `schema.prisma` so consumers stop expecting it. Both are 30-minute jobs; both are overdue.

### SD-MED-6 — `apiHandler`-vs-`withIdempotency` stacking is hard to read and tested by inspection only

**File**: `src/app/api/insights/chat/route.ts:429-450`. The handler peeks at the body to decide whether to wrap in `withIdempotency`, then conditionally invokes the wrapper. The inner `apiHandler` lifts errors → JSON, but the outer dispatch is hand-rolled.

**Why architectural**: Other routes in the codebase mount `apiHandler(withIdempotency(...))` once and trust the wrapper to no-op on missing keys. Here the dispatcher reads the body twice (once to peek, once inside). Move the "should this idempotent-cache?" decision into `withIdempotency` itself (e.g. an `opts.cacheKey` predicate) so callers don't reach into the request body.

**Fix**: Add `withIdempotency(handler, { skipWhen?: (req) => boolean })` so the chat route can `withIdempotency(handler, { skipWhen: hasConversationId })` and the body double-read disappears.

## LOW

### SD-LOW-1 — `coach_usage` carries a redundant index

**File**: `prisma/schema.prisma:932-934`. `@@unique([userId, dateKey])` AND `@@index([userId, dateKey])`. Postgres builds an index for the unique constraint already. The plain `@@index` is dead weight (storage + write cost).

**Fix**: Drop the `@@index` line.

### SD-LOW-2 — `metricSourceJson` stored as `String` instead of `Jsonb`

**File**: `prisma/schema.prisma:899-913`. The provenance envelope is intentionally plain text (the migration's comment explains it's for label-only analytics queries). But Postgres `jsonb` would let admin-app-logs query it without a parse round-trip. Currently the column is `TEXT` and every analytics query needs `jsonb_build_object((metric_source_json::jsonb))`. Cheap to fix while no consumers exist.

**Fix**: Migrate the column type to `Jsonb`. Backwards-compatible (the JSON serialisation is identical).

### SD-LOW-3 — Coach off-topic detector is locale-mixed

**File**: `src/lib/ai/coach/refusal.ts:99-121`. Allow + deny lists mix EN + DE tokens. A French user typing "blutdruck"... tongue-in-cheek aside: the deny list misses obvious off-topic Spanish/French/Italian, and the allow-list will let through any message containing the word "trend" — which "stock market trend" does. Pragmatic enough for v1.4.20; will need expanding when the iOS app launches.

**Fix**: v1.4.21 — feed the detector a `defaultAllow=false` bias and tighten the list. Mark as known.

### SD-LOW-4 — `weeklyReport.weekISO` regex `^\d{4}-W\d{2}$` does not validate week 53 or week 00

**File**: `src/lib/ai/schema.ts:344`. The regex matches `YYYY-Www` but `00`, `54`, `99` would all pass parse. The route page (`/insights/report/[week]`) calls `parseWeekISO()` which IS strict, so the user-facing path is safe. But a future consumer trusting the schema alone would be surprised.

**Fix**: Tighten regex to `^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$`.

## Tech-debt accrual (specific)

1. **Two parallel correlation stacks** (HIGH-2). v1.4.21 author who needs Pearson must read both files to know which one to call. Each release widens the gap.
2. **Snapshot rebuilds per Coach turn** (HIGH-3). Steady-state I/O grows linearly with a user's measurement history, multiplied by chat volume. v1.4.21's first power-user complaint will be Coach latency.
3. **SSE inside idempotency wrapper without a guard** (HIGH-1). The bug is hidden today because the PWA doesn't send `Idempotency-Key`. The iOS app will trip it the day shipping starts.
4. **`medication_schedules.days_of_week` half-migration** (MED-5). Working around schema drift in route after route is the canonical "we'll fix it next release" failure mode. v1.4.20 added a second workaround.
5. **`<CoachDrawer key=...>` state-reset hack** (HIGH-4). The next contributor who patches the drawer will not realise that the parent re-mounts it on every prefill. Unwind this before the drawer grows more state.
6. **Cascade-delete contract drift** (MED-1). The integration test is the GDPR firewall; v1.4.20 added three tables to it without updating the test.
7. **Schema-lift inconsistency in `useInsightsAdvisorQuery`** (MED-2). Two of four new schema blocks are validated, two are cast through `as`. Pick one and apply uniformly.
8. **Fake streaming theatre** (MED-4). The product surface promises "tokens stream in" but the route waits for the full reply. v1.4.21's "stop generating" or "regenerate from token N" features land into a foundation that doesn't actually stream.

## Things to keep

1. **Coach module decomposition.** Splitting `types.ts` / `persistence.ts` / `budget.ts` / `refusal.ts` / `snapshot.ts` / `system-prompt.ts` is the cleanest module boundary in the codebase. Each file is testable in isolation, the dependency direction is one-way (types ← persistence ← snapshot ← (route)), and the unit tests reflect the boundary.
2. **Label-only provenance separated from encrypted bodies.** `metricSourceJson` plain-text + `encryptedContent` AES-GCM is exactly the right shape — analytics-queryable provenance, PII-protected content. The comment block in the migration explaining WHY each column has its encryption choice is a model for future migrations.
3. **404-not-403 cross-user existence guard.** Both the chat and the `/[id]` routes consistently fold "wrong user" → 404. No existence-leak side channel.
4. **Pure correlation runners with `EmptyState` below threshold.** Refusing to surface a marginal `r=0.18` as a "pattern" is the right product-honesty move. The interpretation phrasing locked at the runner level (not the prompt) is the right guard against the model softening it.
5. **`<HealthScoreCard>` as a pure presentational right-side panel.** Server-deterministic compute + client renders only. The same shape will scale to v1.5's "explain my score" expand-card without touching the panel.
6. **`buildHistoryWindow` 20-turn cap with synthetic-summary placeholder.** Bounded prompt budget without paying for a separate summarisation provider call. Right tradeoff for the MVP.
7. **`PROMPT_VERSION` stamped on every persisted assistant message.** Future replay / analytics / per-version helpful-rate slicing all become trivial.

## Cross-link to product-lead review

For the next product-lead pass, the four items below are framing decisions, not code:

- **Fake streaming vs true streaming** (MED-4) — does the product story require token-by-token UX honesty? If yes, v1.4.21 should true-stream and "stop generating" lands as part of the change.
- **Coach rate-limit shape** (MED-3) — what's the per-user RPS the product wants? 30/min default looks safe but should be a product call given the iOS launch.
- **Snapshot freshness for Coach** (HIGH-3) — is "the Coach narrates last hour's data" a feature or a footgun? A 60-second cache is invisible to users; a 24-hour cache might be fine for the dashboard but feels stale for a chat surface.
- **Daily token budget** (25k tokens / user / day) — is this number the product's, or an arbitrary technical pick? Worth pinning down before the iOS launch makes it a billing reality.
