# v1.4.16 Phase-D — Security Review

Reviewer: SECURITY
Scope: v1.4.15..HEAD diff (Wave-A + Wave-B, ~95 commits, ~14k LOC)
Constraint: NO commits, NO source edits, findings-only.

## Verdict

**0 CRITICAL** — no ship-blockers identified for v1.4.16.
**2 HIGH** — defense-in-depth gaps that should land in v1.4.16 patch tier or v1.4.17.
**5 MEDIUM**, **3 LOW**.

The v1.4.16 attack surface is small and well-defended:
- All new endpoints wrapped in `apiHandler()` (verified).
- All admin endpoints call `requireAdmin()` (verified).
- All user-scoped queries filter by `userId` from `requireAuth()` (verified).
- Provider-chain runner respects user isolation; cache is per-userId.
- AI keys remain encrypted with AES-256-GCM and never echoed plaintext.
- Confidence override is server-side; the model's claim is discarded.
- Recommendation feedback attribution is server-side; client cannot tamper.
- GDPR cascade-delete covers `RecommendationFeedback` (migration 0034 + cascade-delete integration test verified).
- JSON inspector renders via React `<pre>{JSON.stringify(...)}` — no `dangerouslySetInnerHTML`.
- `User.id` is cuid (alphanumeric), so `Content-Disposition` filenames carrying it are safe from path-injection.
- In-memory log buffer is bounded to 500 entries (FIFO); cannot grow unbounded under attack.
- Provider chain credential resolution refuses to ship a stale `aiBaseUrl` to OpenAI / Anthropic providers (the v1.4.x SSRF fix from `provider.ts` is preserved by the new `resolveProviderForType` switch).

---

## HIGH

### H1 — Wide-event `meta` field is not redacted before admin egress (B4)

- **Severity**: HIGH
- **File**: `src/app/api/admin/app-logs/route.ts:72-95` (`redactEventForEgress`); `src/lib/ai/provider-runner.ts:262-276` (`ai_chain_hop_*_reason` annotations)
- **Issue**: `redactEventForEgress()` redacts `error.message`, `error.stack`, `warnings[]`, `http.user_agent`, and `external_calls[*].error`, but **does not** redact the `meta` field (`Record<string, unknown>`) or `action.details`. The provider-runner annotates `meta.ai_chain_hop_<n>_reason` with the upstream error message capped at 240 chars (`provider-runner.ts:218-219` — `reason: status !== null ? \`HTTP ${status}: ${message}\` : message`). If an upstream provider (OpenAI, Anthropic, Codex) ever echoes the request `Authorization` header or an `sk-…` / `Bearer …` token in its error body — Anthropic in particular has historically returned the request payload in 4xx errors when JSON malformed — that token lands in `meta` raw and is rendered through the JSON inspector without redaction. The Loki shipper (`transports.emitEvent → appendLogEvent`) writes the raw event into the buffer, so `redactEventForEgress` is the only chance to scrub before the admin UI.
- **Attack scenario**: Attacker (or buggy upstream) provokes a 4xx that includes the bearer token in the response body → annotation captures it → admin (Marc) views `/admin/app-logs` → token visible in JSON inspector → token logged to admin-side telemetry / screenshot if the admin shares a screenshot. Since the in-memory ring is volatile, exposure window is bounded but real.
- **Recommendation**: Run `redactSecrets()` over JSON-stringified `meta` and `action.details` in `redactEventForEgress()` (deep-walk strings, or `JSON.parse(redactSecrets(JSON.stringify(meta)))`). Lowest-risk patch: append `out.meta = JSON.parse(redactSecrets(JSON.stringify(out.meta)))` and same for `action.details` if present. Alternatively, harden at write-time by redacting in `WideEventBuilder.annotate()` — but that's a wider blast radius.
- **Ship-blocker?**: No. Risk is upstream-dependent and the v1.4.16 admin surface is single-tenant (Marc). Should land in next patch (v1.4.17) before any multi-admin scenario.

### H2 — `/api/admin/audit-log` returns raw `details` JSON to admins without redaction (B4)

- **Severity**: HIGH
- **File**: `src/app/api/admin/audit-log/route.ts:127-149` (no `redactSecrets`); `src/components/admin/login-overview-section.tsx:148` (renders `entry.details` raw into the CSV export and React tree)
- **Issue**: The audit-log GET returns `details` (a JSON string column) verbatim to admins. Some legacy audit rows can contain identifiers in `details` (e.g. `auth.login.failed → details: { identifier: <user-supplied login> }` at `src/app/api/auth/login/route.ts:63`). User-supplied `identifier` values are bounded but not filtered for token-shaped strings. If a user pastes `Bearer hlk_...` into the username field of a failed login (typo or recon), the next admin viewing `/admin/login-overview` sees the raw string in the JSON cell and the CSV export. This was acceptable when audit-log was admin-only ad-hoc; B4 productionised the surface (filter, paginate, CSV export), so the egress path is now warm.
- **Recommendation**: Wrap `entry.details` in `redactSecrets()` at the API layer (parse JSON → walk strings → re-serialise) before returning. Same redaction belongs in the CSV export path on the client. Cheaper alternative: have `auditLog()` (in `src/lib/auth/audit.ts:16`) call `redactSecrets()` on every string-shaped value of `details` at write-time so the row never persists a token.
- **Ship-blocker?**: No. Same reasoning as H1 — single-tenant for v1.4.16. Should ship in v1.4.17.

---

## MEDIUM

### M1 — `POST /api/insights/feedback` has no rate limit; aggregator pollution feasible

- **Severity**: MEDIUM
- **File**: `src/app/api/insights/feedback/route.ts:30-103`
- **Issue**: The feedback endpoint requires auth + idempotency + Zod validation, but has no `checkRateLimit()` call. The unique key `(userId, recommendationId, recommendationText)` prevents replay-attack-style spam, but a determined user can submit thousands of distinct feedback rows by varying `recommendationId` (≤200 chars) and `recommendationText` (≤2000 chars). Each row is server-attributed to that user's `providerType` + `promptVersion`, so the attack distorts that user's slice in the aggregator — but cross-user buckets are also distorted because the aggregator buckets on `(severity, metricSourceType, providerType, promptVersion)` not on `userId`. A single user spamming "thumbs-down + providerType=codex" can shift the admin AI quality view's helpful-rate for the entire codex+severity slice.
- **Recommendation**: Add `checkRateLimit("insights-feedback:" + user.id, 60, 60 * 60 * 1000)` (60 / hour seems generous — a user rates one rec per minute at most). Also consider: per-user weighting in the aggregator so a single user cannot dominate a bucket.
- **Ship-blocker?**: No. Marc is single-tenant, so adversarial feedback is N/A in production.

### M2 — `metricSourceType` is client-supplied free-form text (B5e)

- **Severity**: MEDIUM
- **File**: `src/lib/validations/recommendation-feedback.ts:46` (Zod allows `z.string().min(1).max(80)`); `src/lib/jobs/feedback-aggregator.ts:70-92` (used as bucket key)
- **Issue**: The Zod schema accepts any 1-80 char string for `metricSourceType`. There's no allow-list. A client can supply `metricSourceType: "../etc/passwd"` or `"<script>alert(1)</script>"` or any string. Two consequences:
  1. **Bucket-keyspace pollution**: each unique value spawns a fresh bucket, so a malicious client can balloon `AppSettings.adminAiInsightsFeedbackSummary` JSON unboundedly (limited only by 30-day rolling window × 80-char keys).
  2. **No XSS** (admin UI renders via React text node — verified `ai-quality-section.tsx:180`), but the value lands in the audit log `details` blob which then flows into B4's audit viewer.
- **Recommendation**: Pin `metricSourceType` to the same allow-list the AI schema uses (`aiRecommendationSchema.metricSource.type` enum). Same closed enum is used everywhere else in the AI pipeline; only the feedback API accepts wildcard.
- **Ship-blocker?**: No.

### M3 — `audit-log` filter `target` substring on raw `details` field is broad

- **Severity**: MEDIUM
- **File**: `src/app/api/admin/audit-log/route.ts:111-115` (`details: { contains: parsed.target }`)
- **Issue**: The `target` query parameter does a Prisma `contains` substring match on the raw JSON-encoded `details` column. Prisma parameterizes the query (no SQL injection), but the substring match is **case-sensitive** on a JSON-encoded blob and very expensive on a large audit table (full table scan). An admin with `target=a` filter triggers a full-table scan + decoded substring on every row. With 10k+ audit rows + the new B4 paginated UI sweeping pages, the DB becomes the bottleneck. This is a DoS-via-admin not a security boundary breach.
- **Recommendation**: Either (a) require `target` to be exact-match, (b) add a GIN/trigram index on `details` if substring is needed, or (c) bound `target` to ≥3 chars.
- **Ship-blocker?**: No (admin-only).

### M4 — `User.aiProviderChain` JSON column allows tampering via direct DB edit but parser is defensive

- **Severity**: MEDIUM (informational)
- **File**: `src/lib/ai/provider-chain.ts:78-120` (`parseProviderChain`)
- **Issue**: The chain is stored as JSON, parsed defensively at every read with the malformed-row falls-back-to-default contract. The parser correctly: (a) deduplicates, (b) rejects unknown provider types, (c) normalises priority. However, the parser does NOT enforce that priority numbers are unique — a chain like `[{p:1, openai}, {p:1, codex}]` collapses by sort-stability into `[openai, codex]`. The `PUT` endpoint normalises priority to insertion order (route.ts:106-110) so this is not exploitable via the wire, but a direct DB edit could bypass. Defense-in-depth: `parseProviderChain()` normalises priority itself rather than trusting the persisted value.
- **Recommendation**: Mirror the route's normalisation in `parseProviderChain` (`return validSorted.map((e, idx) => ({ ...e, priority: idx + 1 }))`).
- **Ship-blocker?**: No (no exposure since the only writer is the `PUT` endpoint we control).

### M5 — `GET /api/user/ai-provider` decrypts the API key in memory just to expose last-4

- **Severity**: MEDIUM (informational; pre-existing — not v1.4.16, but relevant given B2 expanded UI surface)
- **File**: `src/app/api/user/ai-provider/route.ts:34-41` (`decrypt(...).slice(-4)` for OpenAI + Anthropic)
- **Issue**: Every GET decrypts the full encrypted apiKey to extract the last 4 chars. The plaintext key briefly lives in the V8 string heap (~ms). If the response is logged with `responseBody` capture (per the idempotency replay-cache), there's no key in the response, but the in-process buffer / Glitchtip path could pick up a partial. Also, repeated decryption widens the window for a side-channel timing attack against AES-GCM (negligible in practice, but defense-in-depth).
- **Recommendation**: Store a 4-char preview alongside the encrypted key on write (`aiOpenaiKeyPreview` column, NOT encrypted). Decrypt only when actually building a provider. Same applies to Anthropic.
- **Ship-blocker?**: No. Pre-existing.

---

## LOW

### L1 — Recommendation text stored alongside helpful/notHelpful verdict in DB (per-user)

- **Severity**: LOW
- **File**: `src/app/api/insights/feedback/route.ts:64-75`; `prisma/migrations/0034_recommendation_feedback/migration.sql`
- **Issue**: The audit details record `{recommendationId, severity, helpful, providerType, promptVersion}` — does NOT include `recommendationText` (good). However, `recommendationText` IS persisted to the `RecommendationFeedback` table itself (the dedup partner). An admin reading `recommendation_feedback` directly sees the user's full rec text alongside their helpful/notHelpful verdict. This is by design (Marc's research §3 single-user-default-on policy), but operators on a shared deployment should know.
- **Recommendation**: Document the exposure in `docs/audit/v1416-summary.md` (privacy section) so future deployments understand the per-user-rec storage trade-off.
- **Ship-blocker?**: No.

### L2 — Host-metrics endpoint returns ~1440 rows for `since=24h` with no streaming

- **Severity**: LOW
- **File**: `src/app/api/admin/host-metrics/route.ts:32-56`
- **Issue**: `since=24h` returns ~1440 rows (one per minute) in one JSON response. The route loads all into memory with the BPS computation. At 7d retention an admin could enumerate the full table by dropping the `since` filter — but the route caps to 24h via the enum, so the maximum response is bounded. Not a real DoS.
- **Recommendation**: None required.
- **Ship-blocker?**: No.

### L3 — `redactSecrets` regex does not cover "Authorization: Basic <base64>" or generic JWT shape

- **Severity**: LOW (pre-existing)
- **File**: `src/lib/logging/redact.ts:25-49`
- **Issue**: The redaction rules cover `Bearer <token>`, `bot<n>:<token>`, `sk-…`, `hl[kr]_…`, and query-string secrets. They do NOT cover Basic auth headers or JWT (`eyJ...`) tokens. If an upstream provider ever echoes a JWT in an error message, redaction misses.
- **Recommendation**: Add `Basic\s+\S+` and `\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b` patterns. Risk of over-matching is low since both shapes are token-specific.
- **Ship-blocker?**: No.

---

## Items checked, no finding

- **`POST /api/insights/feedback` auth, idempotency, schema** — all enforced (`apiHandler` + `requireAuth` + `withIdempotency` + Zod). PII: rec text is not in audit details.
- **`GET /api/admin/host-metrics` admin gate** — `requireAdmin()` enforced. No host-info leak: the response is admin-only, no Bearer surface, the `dynamic = "force-dynamic"` guard prevents Edge cache surprise.
- **`GET /api/admin/app-logs` admin gate + redactSecrets** — admin-gated; `redactSecrets()` applied to error.message, error.stack, warnings, user_agent, external_calls[*].error. (See H1 for the gap on `meta`.)
- **`GET /api/admin/audit-log` admin gate + filter pagination** — admin-gated; Zod validates `actor`/`action`/`target`/`since`/`until`/`page`/`perPage`; Prisma parameterizes. No SQL injection.
- **Export endpoints (`/api/export/*`)** — all wrapped in `apiHandler` + `requireAuth`; queries scoped `where: { userId: user.id }`; rate-limit `export:<userId>` 10/h shared bucket; `Content-Disposition` filenames embed cuid (alphanumeric, safe); audit-log entries per export type.
- **Provider chain credential safety** — `resolveProviderForType()` (provider.ts:325) refuses to forward a stale `aiBaseUrl` to OpenAI/Anthropic; LOCAL is the only path that uses `aiBaseUrl`, and the LOCAL path goes through `isPublicUrl()` SSRF guard. AES-256-GCM encryption preserved; no plaintext key in any response.
- **Confidence override safety** — `applyConfidenceOverride()` (generate-insight.ts:214-240) discards `rec.confidence` from the model and replaces with `computeConfidence()`. Wide-event annotation captures the model's value separately for admin observability.
- **Feedback attribution** — `resolveFeedbackAttribution()` (feedback-attribution.ts:70-86) reads the user's most recent `insights.generate` audit row; `pickProviderType()` priority is `chainProviderType > providerType > "unknown"`. Client cannot supply `providerType` / `promptVersion` (Zod schema omits both).
- **GDPR cascade-delete** — `RecommendationFeedback` migration 0034 has `ON DELETE CASCADE` on `user_id` FK; integration test `tests/integration/cascade-delete.test.ts:102+188` verifies the row is gone after user deletion.
- **Comparison snapshot scope** — `buildComparisonSnapshotForUser()` (generate/route.ts:86-150) reads `where: { userId, type }` per metric. No cross-user data path exists.
- **AI section masking** — `<PasswordInput>` used for all three apiKey fields (ai-section.tsx:810, 996, 1158). Last-4 preview only (`...wxyz` shape).
- **Connect/disconnect routes** — `PATCH /api/user/ai-provider` is `requireAuth`-gated. The new `PUT /api/insights/provider-chain` is `requireAuth`-gated, dedupes provider entries, and normalises priority.
- **Provider selection persists per-user** — `User.aiProviderChain` is per-user; no cross-tenant query path.
- **Host-metrics retention cleanup** — `runHostMetricTick` deletes only from `prisma.hostMetric` (`host-metric-sampler.ts:163`); cannot touch unrelated tables.
- **In-memory log buffer growth** — `LOG_BUFFER_MAX = 500` hard cap, FIFO eviction (`in-memory-buffer.ts:24-37`). Per-process. No exposure to attacker-controlled growth (the sampler gates on level).
- **JSON inspector modal XSS** — `<pre>{JSON.stringify(selected, null, 2)}</pre>` (app-log-preview-section.tsx:282-284). Renders via React text node, no `dangerouslySetInnerHTML`.
- **i18n strings via `dangerouslySetInnerHTML`** — no occurrences across v1.4.16 surface (only `src/app/layout.tsx:93` for the theme-init script — pre-existing, unrelated).
- **`apiHandler()` wrap** — verified for `/api/insights/feedback`, `/api/insights/provider-chain` (GET+PUT), `/api/admin/host-metrics`, `/api/admin/app-logs`, `/api/admin/audit-log`, `/api/admin/audit-log/actions`, `/api/admin/ai-quality`, `/api/export/measurements`, `/api/export/medications`, `/api/export/mood`, `/api/export/full-backup`. All present.
- **New routes log auth context via apiHandler** — confirmed via `requireAuth()` / `requireAdmin()` annotation chain.

---

## Summary

The v1.4.16 release ships clean. No CRITICAL findings; the two HIGHs (H1 + H2) are defense-in-depth gaps that matter only at multi-admin scale, which HealthLog has not yet reached. Recommend tracking H1 + H2 + M1 + M2 as a v1.4.17 hardening bucket; M3-M5 + L1-L3 are nice-to-have.
