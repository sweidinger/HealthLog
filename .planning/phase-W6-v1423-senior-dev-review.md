# Wave W6 — Senior-dev review (v1.4.23)

Reviewer: senior-dev lens, read-only
Branch: `develop` @ `72829b1` (29 commits ahead of `main`)
Inputs: phase-W2/W3/W4/W5 reports + diff walk over the four
ship-bundles (W2 Apple Health backend, W3 APNs scaffolding, W4 OpenAPI

- device-management + per-device refresh, W5 hygiene)

## Summary

Architectural posture: **healthy with three structural concerns and
one notable win.** v1.4.23 is the largest "additive surface" release
since v1.4.20: 5 migrations, 8 new routes, two new third-party libs
(`@parse/node-apn`, `zod-openapi`), and a fully-functional Coach
preferences loop. The chunks land in the right places — `apple-health-
mapping.ts` next to its sole caller, `senders/apns.ts` next to the
other channel senders, `coach-prefs.ts` in `validations/` with a
schema-as-defaults pattern that keeps call sites clean. Tests cover
the happy paths and the headline failure modes; integration coverage
followed unit coverage commit-by-commit.

The three structural concerns:

1. **`/api/analytics` is now a fan-out hot-spot.** The route fires
   `findMany`-per-MeasurementType across all 17 enum values plus a
   second SLEEP_DURATION query plus a chunked-but-still-unbounded BP
   read plus 6 correlation queries — every analytics request is a
   ~25-query Prisma flight on a per-user dataset that can be tens of
   thousands of rows. The "chunked" BP perf fix in W5 mitigates the
   payload-marshalling spike but the working-set ceiling is unchanged.
2. **Two device-revoke endpoints are 90% duplicated, neither
   transactional.** `/api/auth/me/devices/[id]` and `/api/devices/[id]`
   each perform refresh-token-revoke + access-token-revoke +
   device-delete as three separate writes — a partial failure leaves
   dangling rows. The duplication is also load-bearing for the audit
   trail: the two routes write the same `devices.revoke` action with
   slightly different `details` blobs.
3. **`metricSourceType` for Coach feedback encodes structured data as
   a string** (`coach:tone=warm:verbosity=default`) and the aggregator
   re-parses it via regex on every run. This works but it's the
   string-coupling anti-pattern; a `tone` + `verbosity` column pair on
   `RecommendationFeedback` would be the same DDL cost and let the
   query planner help.

The architectural win:

- **The OpenAPI registry as a code-driven artifact**, with the legacy
  hand-maintained spec preserved as a sibling and a warn-only CI gate
  to ratchet coverage. The two-stage migration is the right call —
  flipping the gate to hard-fail in v1.4.24+ once the registry
  catches the rest of the surface gives the iOS DTO codegen a
  single-source-of-truth path without forcing a 5000-line schema
  rewrite in one PR.

Findings: **0 CRITICAL · 3 HIGH · 6 MED · 4 LOW**

---

## CRITICAL

(none)

## HIGH

### H1 — `/api/analytics` fans out 17+ findMany queries per request,

reads entire history for every metric type (W2)

**Where:** `src/app/api/analytics/route.ts:35-81` (the type loop) +
`route.ts:92` (sleep-stage breakdown — re-reads SLEEP_DURATION) +
`route.ts:118-141` (BP windows — chunked but unbounded) +
`computeCorrelationHypotheses()` (6 more findMany).

**Symptom:** v1.4.23's enum additions push the type loop from 10 to 17
parallel queries, each unfiltered by date. The pattern is
`prisma.measurement.findMany({ where: { userId, type } })` with no
`measuredAt` cap — the route pulls the user's _entire history_ per
type, runs `summarize()` on it (which only needs the latest few +
totals), and discards the rest. For an iOS user paired with Apple
Health, the analytics-route cost grows linearly with HealthKit days
× metrics-with-data — a realistic 90-day power user holding ~270
HRV samples + ~270 resting-HR + ~5400 step samples + ~270 sleep-
stage rows is already a six-figure-row read per analytics call.

The "chunked" BP fix in W5 (`fetchBpSeriesChunked()`) papers over the
problem for two specific types but doesn't address the root cause:
the route is structured to load every measurement to compute
small-arity summaries.

**Architectural lift:**

- `summarize()` only needs `count`, `latest`, `avg7`, `avg30`. The
  per-type `findMany` should be replaced with a single
  `prisma.measurement.groupBy({ by: ["type"], _count, _avg, _max })`
  scoped to a 30-day window plus a per-type "latest" query, not
  full-history reads.
- The sleep-stage breakdown re-reads SLEEP_DURATION rows that the
  type loop already pulled. Either fold the breakdown into the type
  loop's SLEEP_DURATION branch or let the breakdown drive the
  summary (one read).
- The chunked-fetch helper (`fetchBpSeriesChunked`) accumulates the
  full history into the same `out: BpReading[]` array. The "working
  set ceiling = BP_CHUNK_SIZE" claim in the comment is incorrect:
  the ceiling is `total_rows`. The benefit is purely the Prisma
  intermediate buffer + the index-scan vs full-table-scan path —
  which is real but smaller than the comment implies.

**Severity:** HIGH because the v1.5 iOS app will land high-frequency
HealthKit metrics (steps, HRV, sleep stages) and the analytics route
is on the hot path for the dashboard. The growth is linear in
HealthKit-days, not bounded; this becomes a P1 the moment a TestFlight
user has a 6-month sync history.

### H2 — Two device-revoke endpoints duplicate the cascade, neither

transactional (W4)

**Where:** `src/app/api/auth/me/devices/[id]/route.ts:31-95` and
`src/app/api/devices/[id]/route.ts:26-86`.

**Symptom:** The two routes each perform the same three writes
sequentially:

1. `prisma.refreshToken.findMany` — read access-token hashes
2. `prisma.refreshToken.updateMany` — revoke refresh rows
3. `prisma.apiToken.updateMany` — revoke access-token rows
4. `prisma.device.delete` — drop the device

There is no `prisma.$transaction(...)` wrapper. A failure between
step 3 and step 4 (Postgres connection blip, app crash) leaves the
device row alive with all its tokens revoked — the user's iPad shows
in the device list as "still registered" but every request returns 401. The next-best test for this is "did anyone notice yet" because
no UI surface flags the inconsistency.

The duplication is also a maintenance hazard: the W3-noted use case
("iOS app calls `/api/devices/[id]` on APNs rotation") could just as
easily call `/api/auth/me/devices/[id]` — there's no functional
distinction. The two URLs were retained "to keep the audit trail
consistent" per the W4 report but the audit trail diverges anyway
(`via: "ios.rotation"` only on one branch).

**Architectural lift:**

- Extract a shared `revokeDevice(userId, deviceId)` helper in
  `src/lib/auth/devices.ts`, wrap the four writes in
  `prisma.$transaction(async (tx) => { … })`, return a typed result
  (`{ revoked: boolean, refreshTokensRevoked, accessTokensRevoked }`)
  that both route handlers can render directly.
- Audit-log call shifts into the helper; route handlers pass an
  `origin: "settings" | "ios_rotation"` flag for the `details` slot.
- Picks a single canonical URL — `/api/auth/me/devices/[id]` matches
  the listing route at `GET /api/auth/me/devices`. The
  `/api/devices/[id]` mirror becomes a thin redirect (or stays as a
  thin shim that calls the helper) so iOS-rotation traffic doesn't
  break.

**Severity:** HIGH because the failure mode (orphan device row +
revoked tokens) leaves a user logged out of an account that still
shows the device as paired — confusing, and the only fix is admin
intervention.

### H3 — Coach feedback persists assistant prose plaintext into

`recommendation_feedback.recommendation_text` (W5 H7)

**Where:** `src/app/api/insights/chat/messages/[id]/feedback/route.ts:99-113`.

**Symptom:** The Coach assistant's reply prose has historically lived
encrypted-only (`coach_messages.encrypted_content`, AES-256-GCM via
`@/lib/crypto`). The new H7 route decrypts the message, slices it to
4 KB, and writes it as the `recommendationText` slot of a
`RecommendationFeedback` row. That table is **not** encrypted. The
exact same Coach prose now lives in two places: encrypted in
`coach_messages` and plaintext in `recommendation_feedback`.

This was almost certainly an unintentional consequence of reusing the
v1.4.16 B5e schema, where `recommendationText` was the prose snapshot
of an Insights recommendation (already plaintext on the wire — the
recommendations themselves are not encrypted). The Coach surface
inverts that assumption.

**Architectural lift:**

- Either encrypt the `recommendationText` column on write for
  `targetType="coach"` rows (same `encrypt()` helper, decrypt on
  admin/aggregator read), OR
- Replace the prose-snapshot dedup key with a stable hash of the
  message-id + a content-version counter on the message itself. The
  H7 brief noted the dedup is over "the same message + same prose
  snapshot" — message id alone would be sufficient since assistant
  messages are immutable.

**Severity:** HIGH because the Coach replies can include user-
identifying details the model paraphrases back ("your last week of
BP readings averaged …"). The encryption-at-rest invariant the
Coach surface ships under is silently broken for any message a user
rates.

## MED

### M1 — `coachPrefsJson` is read twice on every Coach turn (W5 H4)

**Where:** `src/app/api/insights/chat/route.ts:209-213` (chat handler
read) + `src/lib/ai/coach/snapshot.ts:264-267` (snapshot builder
read).

The chat route fetches `User.coachPrefsJson`, parses it, builds the
system prompt; then calls `buildCoachSnapshot(userId, scope)` which
fetches the same column independently and reparses it.

**Lift:** Pass `coachPrefs` (or just `excludeMetrics`) into
`buildCoachSnapshot()` as a parameter. Saves one indexed query +
one Zod parse per turn — small but free.

**Severity:** MED — it's a micro-N+1 inside the hot path of the most
expensive endpoint in the app.

### M2 — `feedback-attribution.ts` uses dynamic import to "avoid

circular imports" but no cycle exists (W5 H7)

**Where:** `src/lib/ai/feedback-attribution.ts:135-137`.

The comment claims dynamic-import is needed to avoid a cycle with
`coach-prefs.ts`. Verified: `coach-prefs.ts` only imports `zod/v4`,
no transitive dependency on attribution. The dynamic import adds
async-cost on every call for a defensive measure that protects
against nothing.

**Lift:** Replace with a top-of-file `import { parseCoachPrefs }
from "@/lib/validations/coach-prefs"`.

**Severity:** MED — minor latency, but it's the kind of comment-as-
documentation that future readers will trust without re-verifying.

### M3 — `metricSourceType` for Coach feedback is structured-as-string

(W5 H7)

**Where:** `src/lib/ai/feedback-attribution.ts:104-109`
(`buildCoachMetricSourceType`) +
`src/lib/jobs/feedback-aggregator.ts:205-214`
(`COACH_METRIC_SOURCE_RE`).

Tone + verbosity get encoded as `coach:tone=warm:verbosity=default`
and re-parsed via regex by the aggregator. Aggregations group by
this string. Anyone adding a third dimension (e.g.
`excludeMetricsCount`) has to update the encoder, the regex, and
the parser, with no compiler help and a silent fallback to
`tone="unknown"` when the regex misses.

**Lift:** Add `tone` + `verbosity` columns to
`RecommendationFeedback` (already nullable for non-coach rows), let
the aggregator `groupBy: ["promptVersion", "tone", "verbosity"]`
directly. The migration is one ALTER TABLE.

**Severity:** MED — the existing pattern works but is the kind of
debt that compounds the moment a fourth dimension lands.

### M4 — `apple-health-mapping.ts` declares `aggregation` and

`isPrivacySensitive` fields nothing reads (W2)

**Where:** `src/lib/measurements/apple-health-mapping.ts:28-62` and
the table entries that populate them.

Both fields are declared on the `AppleHealthMapping` interface and
filled in for every entry, but nothing in the runtime path consumes
them — `mapAppleHealthEntry()` only reads `measurementType`,
`convertToDbUnit`, `dbUnit`, `sleepStageMap`. The
`isPrivacySensitive` flag has a single test reference (filtering
the table to assert the marked entries are the expected ones). The
`aggregation` hint is documented as "advisory metadata for
downstream summarisation" — i.e., aspirationally consumed.

**Lift:** Either delete the fields (YAGNI — re-add when the
audit-trail or analytics consumer materialises) or wire them up
behind a v1.4.24 commit that actually consumes them (privacy-
sensitive ingest gets a separate audit-log action; aggregation hint
drives the analytics-route per-type rollup).

**Severity:** MED — dead structural vocabulary teaches future
contributors a pattern that doesn't exist.

### M5 — `isCurrent: true` in `GET /api/auth/me/devices` trusts the

`X-Device-Id` header without authentication (W4)

**Where:** `src/app/api/auth/me/devices/route.ts:35,60`.

The route reads `X-Device-Id` from the request header and marks the
matching row as `isCurrent: true`. There is no check that the
supplied id matches the device behind the current refresh-token /
session. A malicious client can flag any of their own device rows
as `isCurrent` — low impact (only their own UI), but it means the
field is a presentation hint that _looks_ like an authentication
fact.

**Lift:** Resolve the current device id from the auth context (the
refresh token's `deviceId`, the session's bound device, or absent
for cookie-only callers) and only mark that one. The `X-Device-Id`
header stays as the cookie-only-caller fallback.

**Severity:** MED — the failure mode is "user lies to themselves";
real impact is zero today, but it's a UI-as-truth pattern that will
get reused if not corrected.

### M6 — APNs `apns_not_configured` returns `hardReject: false`,

silently burning channel-state failure budget (W3)

**Where:** `src/lib/notifications/senders/apns.ts:208-216` and
`:309-318`.

When the APNs env vars aren't set (the v1.4.23 default — APNs is
scaffolded but no operator config exists yet), `sendViaApns` returns
`{ ok: false, hardReject: false, reason: "apns_not_configured" }`.
The dispatcher classifies that as a transient failure and bumps the
channel-state machine's `consecutiveFailures` counter. After 5
dispatch cycles the channel auto-disables — but the cause was never
transient, the operator just hadn't enabled APNs.

This is dormant in v1.4.23 because no code path creates an APNS
NotificationChannel row (the dispatcher's branch is wired but
unreachable until v1.5). The bug becomes live the moment the iOS
device-registration flow creates the channel row.

**Lift:** Treat `apns_not_configured` as either (a) a hard-reject
with a typed reason that the channel-state machine recognises and
keeps the channel **enabled but cooled down indefinitely until the
config arrives**, or (b) a special "skip without counting" outcome
that the dispatcher loop short-circuits on.

**Severity:** MED — pre-condition for v1.5 P4. Worth fixing now
while the surface is dormant, before a TestFlight build paints the
"channel auto-disabled" toast at the user.

## LOW

### L1 — `docs/api/README.md` describes manual openapi.yaml editing,

now overwritten by the generator (W4 F5)

**Where:** `docs/api/README.md:67-77` ("Updating the spec" section)
contradicts `scripts/generate-openapi.ts` which overwrites the file
on every run.

**Lift:** Replace the "Updating the spec" section with the actual
flow ("schemas live in `src/lib/validations/*` with `.meta()`
annotations; route table in `src/lib/openapi/routes.ts`; run
`pnpm openapi:generate`"). Add a banner comment at the top of
`docs/api/openapi.yaml` warning that hand edits will be overwritten.

### L2 — `buildOpenApiDocument` uses `require()` to lazy-load routes

(W4 F5)

**Where:** `src/lib/openapi/registry.ts:65-76`.

The registry calls `require("./routes")` inside the builder with an
ESLint-disable. The comment justifies it as "lazy-load so the base
scaffolding stays usable from devtools-only consumers" — but no
such consumer exists, and the dynamic require defeats both
typecheck-narrowing and tree-shaking. Replacing with a top-of-file
import is one diff.

### L3 — `fetchBpSeriesChunked` cursor is single-column on a

composite-ordered query (W5 H2)

**Where:** `src/app/api/analytics/route.ts:455-483`.

`orderBy: [{ measuredAt: "asc" }, { id: "asc" }]` paired with
`cursor: { id: cursorId }`. When two rows share a `measuredAt`
value (manual bulk imports do this routinely), the cursor's `id`-
only positioning may drop or duplicate rows on ties. Prisma docs
recommend matching cursor shape to the orderBy shape (compound
unique).

**Lift:** Either drop `measuredAt` from the orderBy (cursor by `id`
alone, sort the in-memory accumulator after) or use a compound
cursor (`cursor: { measuredAt_id: { measuredAt, id } }` once an
appropriate index exists).

### L4 — Apple Health mapping table comment mentions a "16 unit tests"

claim that doesn't match the diff (W2 doc)

**Where:** `.planning/phase-W2-v1423-report.md:27` and the
underlying test file. The mapping test file is fine — small nit on
the report.

---

## What's well-done — keep doing it

- **Migration ordering is safe.** Five new migrations
  (0036/0037/0038/0039/0040), every one strictly additive: ADD
  COLUMN nullable, ADD VALUE IF NOT EXISTS, CREATE INDEX/TYPE,
  CHECK constraints scoped to NULL OR (X). No reordering, no row
  mutations, no contention. The 0036 `ALTER TYPE ADD VALUE` rows
  follow the established pattern from 0021/0022/0024 — the new
  values aren't consumed in the same migration's subsequent
  statements (only the brand-new `sleep_stage` enum is, and that
  was `CREATE TYPE`, not `ALTER`). Deploy ordering is bullet-proof.
- **`coachPrefsSchema` defaults are inlined into the schema.**
  `safeParse({})` returns the legacy v1.4.22 defaults — no `?? defaultX`
  call sites, no schema-vs-defaults drift. The pattern travels well
  to future per-user-toggle additions.
- **`channelPriority()` makes the dispatcher cascade deterministic.**
  Replacing the implicit Postgres-scan order with a static priority
  sort is the right call. Unknown types defaulting to `99` keeps
  experimental channel rows from preempting real ones.
- **Per-device refresh-token revocation with the legacy fallback.**
  The W4 H5 fix correctly scopes the blast radius to the
  originating device ID while keeping `null deviceId` rows on the
  wide revoke. The two-device test pinning the boundary is
  excellent — exactly the kind of test that prevents a future
  "let me clean this up" from re-broadening the scope.
- **OpenAPI generator + warn-only CI gate as a two-stage migration.**
  Strict subset → ratchet → flip to hard-fail is the textbook
  approach. Preserving `openapi-v1422-legacy.yaml` as a sibling
  reference during the transition is the right call.
- **Apple Health batch ingest's per-entry status (`inserted | duplicate
| skipped`).** Rather than fail-the-batch, the route degrades each
  entry independently and surfaces a typed reason for skipped rows.
  iOS clients can advance their sync cursor accurately and operators
  can investigate per-row reasons without re-running the upload.
- **`useResettableValue` hook replaces the v1.4.20 `key={prefill}`
  weaponisation.** Render-phase setState matching React's official
  recommendation, ESLint-clean against
  `react-hooks/set-state-in-effect`. Pure decision function
  (`nextResettableValue`) is independently unit-testable. The W5 H3
  refactor is exemplary.

---

## For product-lead-review cross-link

Two items worth flagging for the v1.5 P1 risk register:

- **`/api/analytics` scaling cliff (H1).** When the iOS client lands
  HealthKit ingest in v1.5, the dashboard's analytics request will
  hit the 17-type fan-out + per-type full-history reads on every
  load. A user with 6 months of HRV samples (~180 rows) + 6 months
  of step samples (~5 400 rows if pulled per-hour, ~180 if pulled
  per-day) is a realistic v1.5 P1 power user. The route's read
  shape needs the `groupBy` rewrite **before** TestFlight
  distribution, or the dashboard becomes the iOS app's first
  performance complaint.

- **Coach feedback prose stored plaintext (H3).** The Coach is the
  v1.5 differentiator. Storing plaintext assistant prose in
  `recommendation_feedback` for any rated message breaks the
  encryption-at-rest invariant the Coach ships under and lives
  forever in DB backups. Worth resolving before the H7 thumbs row
  is exposed publicly — the table schema fix is an ALTER, not a
  rewrite.

The third HIGH (H2 — duplicated device-revoke endpoints + missing
transaction) is a maintenance / data-integrity concern that won't
manifest until a Postgres blip lands inside the cascade. Fix it
opportunistically; it's not a v1.5 ship-blocker.

---

## Verification context

This review is read-only over `develop @ 72829b1`. Migration
ordering verified by `ls prisma/migrations/`. The findings are
based on diff-reading and selective grep, not on running the test
suite — every chunk's report claims green
`pnpm typecheck / lint / test --run / test:integration / openapi:check`,
and I trust those reports. Where a finding cites a line number the
referenced file was read in full (or the relevant 80-line window)
during this review.
