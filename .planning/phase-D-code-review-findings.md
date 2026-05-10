# Phase D — Code-review findings (v1.4.16)

Reviewer: senior code-review (parallel with security / design / senior-dev / simplify / Product Lead).
Scope: diff `v1.4.15...HEAD` — Wave A (A1–A8), Wave B (B1a/b, B2, B3, B4, B5a–e, B6, B7, B8), Wave C (CI + deferred HIGH).
Method: targeted reads of hot paths — AI provider chain + confidence + schema (B5a–d), feedback loop (B5e), host-metrics + app-logs (B3/B4), exports (B7), comparison overlay (B8), BD-Zielbereich predicate (A2). No source edits, no commits.

---

## CRITICAL — ship-blocker

(none)

---

## HIGH

### H1. Bucket-key collision in `feedback-aggregator` allows cross-bucket pollution
- **File:** `src/lib/jobs/feedback-aggregator.ts:70-75`
- **Issue:** `[severity, metricSourceType, providerType, promptVersion].join("")` uses the empty separator. `severity` is bounded enum but `metricSourceType` is free-form (z.string().min(1).max(80)) and `providerType`/`promptVersion` are wire-stamped. Collision example: `severity="info"` + `metricSourceType="important"` collides with `severity="important"` + `metricSourceType="info"` — both produce key `"infoimportant…"`. The first to arrive wins ownership; subsequent rows accumulate counts onto a row whose displayed `(severity, metricSourceType)` belongs to the wrong tuple, silently poisoning the admin AI quality slice.
- **Recommendation:** Join with an unambiguous separator that cannot appear in any of the four fields, e.g. `\x1f` (US) or a JSON tuple: `JSON.stringify([severity, metricSourceType, providerType, promptVersion])`.
- **Ship-blocker for v1.4.16?** Yes for the admin AI-quality feature semantics; can be deferred if the dashboard is treated as best-effort observability.

### H2. `FallbackChainCard` discards the persisted `enabled` flag — disabled providers vanish from the UI
- **Files:** `src/app/api/insights/provider-chain/route.ts:49-56`, `src/components/settings/ai-section.tsx:1272-1283`
- **Issue:** The GET response only returns `{ providerType, available }`. The UI seeds `enabled: true` for every entry (`chain.map((c) => ({ providerType: c.providerType, enabled: true }))`). But `resolveProviderChain()` upstream (`src/lib/ai/provider.ts:306`) **filters out disabled entries before returning** (`parseProviderChain(rawChain).filter((e) => e.enabled)`). Net effect: a user who disables an entry sees it disappear from the list; on reload it cannot be re-enabled because it's not present, and the toggle position is lost. The UI advertises the toggle as a "disable in fallback chain" affordance but is functionally a "remove from chain" button.
- **Recommendation:** GET should return the raw persisted `parseProviderChain(rawChain)` (not the resolveProviderChain filtered list) plus `available` per entry. The UI then renders both enabled and disabled rows so the user can re-enable. Or: remove the toggle entirely and only support add/remove.
- **Ship-blocker for v1.4.16?** Yes — it's a regression vs. the documented B2 brief ("toggle drives enable/disable"). Either fix the round-trip or remove the Switch from the row.

### H3. Strict B5b/B5c/B5d AI features are not wired into the production route
- **Files:** `src/app/api/insights/generate/route.ts:280-393`, `src/lib/ai/generate-insight.ts`, `src/lib/ai/provider-runner.ts:229-288`
- **Issue:** The production `/api/insights/generate` route uses `runRawCompletionWithFallback()` (raw `provider.generateCompletion`, no schema enforcement, no rationale check, no confidence override). The strict `runWithFallback()` + `generateInsight()` (which enforces `aiRecommendationRationaleSchema`, runs the corrective retry, OVERRIDES `rec.confidence` deterministically, annotates `ai_confidence_override_pairs`) is consumed only in tests. Result: in production, the model's self-reported confidence is what users see — defeating B5d's "calibrated probabilities are not a small-LLM strength" mandate; rationale + citation enforcement is observational only via `insightResultSchema.safeParse()` falling back to raw parsed JSON on validation failure (line 386 `insights = validated.success ? validated.data : parsed`).
- **Recommendation:** Either (a) migrate `/api/insights/generate` to `runWithFallback()` + new `aiInsightResponseSchema`, replacing the legacy passthrough — STATE.md notes this as a deferred "v1.4.17 migration"; or (b) add a **runtime feature-flag** gate so the strict path can be enabled in prod without a code release. Today's `applyConfidenceOverride()` and rationale-required schema are dead code in production.
- **Ship-blocker for v1.4.16?** Maybe — depends on whether v1.4.16's release notes claim "deterministic confidence" or "rationale-required" as user-facing features. STATE.md B5c/B5d both say "complete on origin/main" but the production path is unchanged. Users will see model-claimed confidence values, not server-computed ones. Recommend explicit Marc-call: ship with feature dark + clearer release-notes wording, or migrate the route.

### H4. `findRecommendationsMissingRationale` is a no-op against parsed AIInsightResponse
- **File:** `src/lib/ai/schema.ts:283-297`, `src/lib/ai/generate-insight.ts:158-175`
- **Issue:** The strict schema requires `rationale` (`aiRecommendationRationaleSchema` is required on every rec — line 157). If the parser succeeds, every rec will have a rationale, so the helper always returns `[]`. The Wide-Event annotation `ai_rationale_missing_recommendation_ids` is therefore always empty in the strict path — and the strict path is the only place the helper fires. The "observability tripwire for the migration window" comment is misleading.
- **Recommendation:** Either feed it a separate looser-typed pre-parse blob (e.g. the JSON before `aiInsightResponseSchema.safeParse()` runs), or move the call to the `isLegacyInsightPayload()` cache-hit path where it would actually surface drift. Document or remove the tripwire claim.
- **Ship-blocker for v1.4.16?** No — observability dead-code is not a functional bug. Worth fixing for clarity.

### H5. `recommendation-feedback` has no rate-limit
- **File:** `src/app/api/insights/feedback/route.ts:30-101`
- **Issue:** No `checkRateLimit()` call. Each thumbs-click writes one `RecommendationFeedback` row + one `audit_logs` row. The unique index `(userId, recommendationId, recommendationText)` prevents exact-duplicate inserts, but a malicious client can rotate `recommendationId` or `recommendationText` per request and flood the DB. Idempotency-Key cache only catches identical retries with the same key.
- **Recommendation:** Add `checkRateLimit('feedback:${user.id}', 60, 60 * 60 * 1000)` (60/h is generous — a comprehensive insight rarely has >10 recs, so ≥6 regenerations/h before throttle hits).
- **Ship-blocker for v1.4.16?** No — single-user scoped, inside-auth. Fix in v1.4.17.

### H6. `recommendation-feedback` invalidates the entire `["insights"]` cache on every thumbs click
- **File:** `src/components/insights/recommendation-feedback.tsx:192`
- **Issue:** `queryClient.invalidateQueries({ queryKey: ["insights"] })` matches ALL `["insights", …]`-prefixed keys (8 queries: comprehensive + 7 per-status). On thumbs success this kicks off a synchronous refetch of all 8 — none of which are affected by the feedback row itself. Refetching the comprehensive blob requires a 1500-token LLM call (rate-limited 10/h) — the only thing that prevents this is the 24h server-side cache-hit path. Effectively the user gets no surprise refetch in practice but the network and cache thrash is wasted work, and on a stale cache it's a real LLM round-trip.
- **Recommendation:** Drop the invalidation entirely; feedback doesn't affect the displayed insight content. If a future mode (B5e ratchet in v1.4.17) makes feedback feed back into next-gen prompts, scope the invalidation to the per-status / comprehensive query that would consume the new prompt.
- **Ship-blocker for v1.4.16?** No — minor performance smell.

### H7. Comparison overlay re-uses already-fetched `data` as the "prior period" — there is NO prior-period data
- **Files:** `src/components/charts/health-chart.tsx:524-563`, `src/lib/charts/comparison-shift.ts`
- **Issue:** `chartDataWithCompare` shifts the SAME `data` array forward by 30/365 days. The dashboard fetcher upstream pulls `data` as the visible window only (e.g. last 30 days). Shifting today's last-30-days forward by 30 days produces "today's data overlaid 30 days into the future" — not "last month's data overlaid onto today". For the comparison to be meaningful the chart needs a SEPARATE fetch of the prior 30/365-day window. STATE.md B8 says "shift the SAME daily aggregates and shift them forward by 30 days (lastMonth) or 365 days (lastYear) so the prior period lines up with the current period on the visible x-axis" — only correct if `data` already contains BOTH periods. Verify upstream `data` covers the full extended range.
- **Recommendation:** Audit the call site — does the dashboard fetcher pull `now - rangeDays` only, or `now - rangeDays - shift`? If the former, the overlay shows `current_period` at `current_period + 30d` (a phantom future overlay). If the latter, OK. Add a unit test that pins `data` containing both periods and asserts the visible overlay maps to the prior-period values, not the current period's values.
- **Ship-blocker for v1.4.16?** Possibly — needs fast verification. If `data` is single-period, the overlay is structurally meaningless.

### H8. `seedKey` includes potentially-undefined `chainData?.activeProvider` so race between query resolution and URL change re-seeds twice
- **File:** `src/components/settings/ai-section.tsx:228-241`
- **Issue:** `seedKey = `${queryProvider ?? ""}|${chainData?.activeProvider ?? ""}`` mutates between renders — first render `chainData` is undefined → seedKey ends with `"|"`; on chainData arrival → seedKey ends with `"|codex"`. The `seededFor !== seedKey` branch fires twice, second time setting `selectedProvider` from chainData. If the user has already clicked a different provider in the dropdown between the two renders, their click is silently overridden by the chainData arrival.
- **Recommendation:** Track the user-interaction state separately (`userPicked: boolean`) and gate re-seeding on `!userPicked`. Or only seed once on the first non-undefined `chainData`.
- **Ship-blocker for v1.4.16?** No — narrow race window, recoverable by re-clicking. Fix in v1.4.17.

---

## MEDIUM

### M1. `/api/admin/audit-log/actions` does an unbounded `groupBy(action)`
- **File:** `src/app/api/admin/audit-log/actions/route.ts:22-25`
- **Issue:** No index on `audit_logs.action`. With 1M+ rows the `groupBy` becomes an aggregate scan. Result is also un-cached.
- **Recommendation:** Add an index on `audit_logs.action`, OR cache the result for 5 min server-side, OR LIMIT the distinct list to the 100 most recent actions.

### M2. `RecommendationCard` `metricTypeToChartTypes()` falls through to verbatim type — silent passthrough
- **File:** `src/components/insights/recommendation-card.tsx:114-135`
- **Issue:** Unknown `metricType` returns `[metricType]` as-is. `HealthChart` then receives an unrecognised type and renders empty. Comment says "render empty rather than nothing" but the user sees nothing useful — a model that emits `metricSource.type = "BloodPressure"` (capitalised) gets dropped because the `lower === "bloodpressure"` branch hits a different casing for legacy-typed payloads. Worse: the model can emit any string.
- **Recommendation:** Allowlist explicitly; unknown types skip the mini-chart entirely (return `[]`). Add a Wide-Event annotation `ai_rec_unknown_metric_type` for observability.

### M3. `appendLogEvent` runs unconditionally even for high-volume background jobs
- **Files:** `src/lib/logging/transports.ts:93-104`, `src/lib/logging/in-memory-buffer.ts`
- **Issue:** Every emitted event lands in the 500-entry ring buffer. For a worker process running pg-boss every minute this means the buffer is dominated by background events, leaving no space for HTTP request events that admins are more likely to debug. Plus the buffer is per-process so the web buffer never sees background events anyway — they ship to a buffer no admin reads.
- **Recommendation:** Skip background events from the buffer when `event.kind === "background"`, or partition by kind. The Loki sink still receives them.

### M4. `redactEventForEgress` does not redact `meta` or `action.details`
- **File:** `src/app/api/admin/app-logs/route.ts:72-96`
- **Issue:** Only `error.message`, `error.stack`, `warnings`, `http.user_agent`, `external_calls[].error` are redacted. `meta` and `action.details` carry annotated key=value pairs from `annotate()` calls — if any handler accidentally annotates a token (e.g. an Idempotency-Key replay logging the `Authorization` header), it leaks to the admin UI in raw form.
- **Recommendation:** Run `redactSecrets` recursively over `meta` and `action.details` string values too. Or whitelist a closed set of meta keys the egress allows.

### M5. `chainBodySchema.providerType` cast `as unknown as [string, ...string[]]`
- **File:** `src/app/api/insights/provider-chain/route.ts:60-62`
- **Issue:** Double-cast hides the type. zod accepts `readonly [string, ...string[]]` from a tuple; `PROVIDER_CHAIN_TYPES` is declared with `as const` so it should already match. The double-cast risks a future PROVIDER_CHAIN_TYPES being non-tuple typed without compile error.
- **Recommendation:** `z.enum([...PROVIDER_CHAIN_TYPES] as readonly [string, ...string[]])` or use zod's `z.enum(PROVIDER_CHAIN_TYPES)` directly — the `as const` should already produce the tuple.

### M6. `ContractCard` minor — "draft" pill doesn't use `litBarsFor` clamp comment correctly
- **File:** `src/components/insights/confidence-meter.tsx:55-64`
- **Issue:** Comment says "0..20 is 1, 21..40 is 2"; `Math.ceil(0/20) = 0` → clamped to 1; `Math.ceil(20/20) = 1`; but value < 25 routes to `draft` band BEFORE this is consulted. The clamp `if (lit < 1) return 1` defends against `value=0` for non-draft band, which is unreachable since `bandFor(0) === "draft"`. Dead code path; comment is correct in spirit but misleading.
- **Recommendation:** Drop the `lit < 1` clamp or document it as "defensive for refactoring."

### M7. `host-metrics` route returns `BigInt → Number` without overflow guard
- **File:** `src/app/api/admin/host-metrics/route.ts:90`
- **Issue:** `Number(row.memTotalBytes)` and `Number(readDelta)` — if memTotalBytes ever exceeds 2^53 (~9 PB) precision is lost. Disk byte counters are cumulative; on a long-running machine they could overflow given enough time.
- **Recommendation:** Acceptable for v1.4.16 (typical hosts <16 GiB RAM, disks <10 PiB throughput). Document in the route comment.

### M8. `feedback-aggregator` `await prisma.appSettings.upsert` swallows errors silently
- **File:** `src/lib/jobs/reminder-worker.ts:951-972`
- **Issue:** Worker catches and warns but doesn't requeue. If the upsert fails (DB connection blip, lock contention) the day's summary is lost — admin AI-quality dashboard shows yesterday's data.
- **Recommendation:** Let pg-boss retry the job on throw (default behaviour). If retry storm is the concern, add a `maxRetries: 3, backoff: exponential` to the queue config. Today's "swallow + log" is too aggressive.

### M9. `host-metric-sampler.getHostMetricRetentionDays` redundant double-check
- **File:** `src/lib/jobs/host-metric-sampler.ts:120-131`
- **Issue:** Returns DEFAULT for `parsed <= 0`, then again for `parsed < 1`. The second check is unreachable for valid integers.
- **Recommendation:** Drop the second check.

---

## LOW

### L1. `evictPerStatusInsightCache` Prisma query uses both `startsWith` and `AND[contains]`
- **File:** `src/app/api/insights/generate/route.ts:62-73`
- **Issue:** `where: { userId, action: { startsWith: "insights." }, AND: [{ action: { contains: "-status." } }] }`. The combined `AND` is redundant under "where AND" semantics — Prisma already AND's all top-level keys. The `AND` wrapper is needed only because the top-level `action` key already has a `startsWith`; piling another `action` filter inside an `AND[]` is the right pattern. Comment is good.
- **Recommendation:** Looks right, no change needed. Considered nit.

### L2. `evictPerStatusInsightCache` does not annotate the row count it deleted
- **File:** `src/app/api/insights/generate/route.ts:62-73`
- **Issue:** `deleteMany` returns `{ count }` which is dropped.
- **Recommendation:** Annotate `evicted_status_caches` so admin observability sees the eviction.

### L3. `provider-runner` legacy `runRawCompletionWithFallback` is duplicated code
- **File:** `src/lib/ai/provider-runner.ts:312-371`
- **Issue:** Near-identical to `runWithFallback` (lines 229-288); diff is the inner `provider.generateCompletion` vs `generateInsight` call. The cache logic, fallbackHops shape, error classification, and Wide-Event annotation are duplicated.
- **Recommendation:** Extract a shared helper `runChain<T>(args, runOnce)` that takes the per-attempt callback. Defer if v1.4.17 is migrating the legacy route anyway.

### L4. `RecommendationsGrid` STAGGER_INTERVAL_MS = 100 ms — a 10-rec response takes 1s to fully animate in
- **File:** `src/components/insights/recommendations-grid.tsx:81`
- **Issue:** No upper bound on stagger total. Worst case 10 recs * 100 ms = 1s before last card lands.
- **Recommendation:** Cap with `min(index * 100ms, 600ms)` so late cards fade in immediately after the cascade-cap.

### L5. `findClosestDia()` allows multiple sys to pair with the same dia
- **File:** `src/lib/analytics/bp-in-target.ts:80-100`
- **Issue:** Each sys picks its own closest dia independently. A burst of sys readings between two dia readings will all match the closer dia. Counts inflated for high-frequency sys-only logging.
- **Recommendation:** Acceptable for the 5-min-window pair-rule; closing pair after consumption would change semantics. Document or accept.

### L6. `host-metrics-chart.tsx` `Intl.DateTimeFormat` recreated per `buildChartRows` call
- **File:** `src/components/admin/host-metrics-chart.tsx:93-97`
- **Issue:** Locale formatter is created inside the pure helper, but the helper itself is wrapped by `useMemo`. Each unique `data?.samples` reference triggers re-instantiation. Cheap per call, but wasteful.
- **Recommendation:** Move the formatter to module-scope.

### L7. `legacy-payload.ts` checks `rationale === undefined` AND `=== null` AND `typeof !== "object"` separately
- **File:** `src/lib/ai/legacy-payload.ts:46-52`
- **Issue:** `typeof rationale !== "object"` already returns true for undefined and null in JS. The early checks are belt-and-braces but redundant.
- **Recommendation:** Simplify to `if (rationale === null || typeof rationale !== "object") return true;` — `undefined` is also `typeof "undefined"` so the check covers it.

### L8. Comparison overlay `_compare` data keys cannot collide with metric types but use string concat
- **File:** `src/components/charts/health-chart.tsx:558`
- **Issue:** `merged[`${type}_compare`] = v` — relies on no metric type ending with `_compare`. Stable today, fragile to a future `WEIGHT_compare` enum value (unlikely but possible).
- **Recommendation:** Prefix with a non-identifier separator: `merged[`__compare__:${type}`]`. Or a `Map`. Acceptable as-is.

### L9. `ai-section.tsx:1255` — `seededKey` joined with `,` from providerType, not stable JSON
- **File:** `src/components/settings/ai-section.tsx:1270`
- **Issue:** `chain.map((c) => c.providerType).join(",")` is derived from `chain`, which only changes when GET refetches. Same providerType-set in different order produces the same key — but if two reorderings happen before re-seed, the local entries diverge from the GET. Edge case; fine.

### L10. `host-metrics` route does NOT cache prev BigInt across HTTP calls
- **File:** `src/app/api/admin/host-metrics/route.ts:85-122`
- **Issue:** Per-request `prevReadBytes` walk; the first row in the returned window has `diskReadBps: null` because there's no previous sample to delta from. UI hides the line for that row. Documented behaviour. Fine.

---

## Cross-cutting

### Plan-deviation observations

- **B5b/B5c/B5d strict path is dark in production** — the production `/api/insights/generate` route still rides the `runRawCompletionWithFallback()` legacy shape. STATE.md acknowledges this as a "v1.4.17 migration" deferment, but the user-facing claims of "rationale required", "deterministic confidence", and "citation enforcement" are exercised only by tests. See **H3** above. Recommend explicit Marc decision before tagging v1.4.16: ship dark + adjust release-note language, OR migrate route to strict path.
- **A2 BD-Zielbereich predicate change is structurally sound** — `isBpReadingInTarget` ceiling+floor semantics centralised across all 6 call sites. Marc's stated 50% expectation is plausible given the `90 ≤ sys ≤ sysHigh AND 50 ≤ dia ≤ diaHigh` predicate; integration test `tests/integration/bp-in-target.test.ts` covers it. No drift risk.
- **B7 export endpoints** — well structured, share `export:<userId>` rate-limit bucket, audit-log on every download, no envelope-wrap on the file contents. `full-backup` round-trips through the canonical `BACKUP_SCHEMA_VERSION` shape so admin upload + restore accepts it. Clean.
- **Wave-C qemu-arm64 drop** — well-documented in `docker-publish.yml`. amd64-only is the right call given Marc's prod target. v1.5 path documented.

### Tests + i18n parity

- New SSR + integration tests are present for each new endpoint and for `RecommendationCard` rationale + confidence + feedback wiring.
- `recommendation-feedback.test.tsx` not located in the repo — STATE.md B5e claims +20 tests; the wire integration `tests/integration/insights-feedback.test.ts` covers the API but the component is exercised through the integration harness only, not isolated.
- i18n parity: B5a/B5e/B8 add EN+DE keys with parity tests. No drift detected.

---

## Severity rollup

- **CRITICAL:** 0
- **HIGH:** 8 (H1-H8)
- **MEDIUM:** 9 (M1-M9)
- **LOW:** 10 (L1-L10)
