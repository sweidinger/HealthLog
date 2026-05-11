# v1.4.23 — Product-Lead Review

Author: Marc (strategic memo to self)
Date: 2026-05-11
Status: pre-release of v1.4.23; W2 Apple Health foundation +
W3 APNs scaffolding + W4 OpenAPI/Coach/native-auth + W5 hygiene
all on `develop`. W6 multi-agent review in flight (this memo is
the product-lead leg). v1.4.22 went out the door yesterday;
v1.4.23 is the next tag. This memo updates
`.planning/phase-W5-v1422-product-lead-review.md`. Same audience:
Marc-three-weeks-from-now. The question this version answers:
**what backend foundation does v1.5 — the iOS native client +
Apple Health integration — now have on day zero, and what does
v1.5 P1 (iOS first launch) actually need to be now that the
contracts exist?**

---

## A. State of the App after v1.4.16 → v1.4.23

The arc is now eight releases long and the rhythm has held for
two cycles in a row. **v1.4.16** was the polish-leap that
overshot. **v1.4.17** was the schema-strictness hotfix.
**v1.4.18** walked back the visual overshoots and grew
Achievements. **v1.4.19** was the deliberately-boring polish that
lined up the runway. **v1.4.20** was the deliberately-loud
product release: Coach drawer + streaming + Daily Briefing +
correlations + Weekly Report + Health Score. **v1.4.21** was a
five-commit e2e-stability fix wave. **v1.4.22 was the long-tail
polish release** that closed loops carried since v1.4.16 — the
Coach prose rewrite + sentinel block + BD-Zielbereich re-anchor +
target-page sparklines.

**v1.4.23 is something the v1.4.x line hasn't done before: a
release whose user-visible delta is small on purpose because the
weight is in the foundation under it.** Seven hygiene items + an
Apple Health measurement schema + APNs scaffolding + an OpenAPI
generator + per-device refresh-token revocation + a Coach
settings cog + a per-message thumbs-feedback loop. None of those
are loud features; together they're the shape of v1.5's contract
surface, frozen in code before the iOS app starts compiling
against it. The cadence has matured beyond the loud/quiet
two-beat into a three-beat: **loud release → polish release →
foundation release**. v1.4.20/v1.4.22/v1.4.23 was the first time
we ran the whole cycle.

**Quality bar trajectory: a sideways step on the surfaces, a
visible step-up under them.** No new product-surface noise; the
Insights page didn't grow; the Coach prose stayed where v1.4.22
parked it. What changed is that `POST /api/measurements/batch`
exists, `POST /api/devices` accepts an `apnsToken`, the OpenAPI
spec regenerates byte-identically across runs, and the refresh-
token replay-detection no longer punishes a two-device user.
None of those show up in the UI. All of them remove a class of
"v1.5 bogs down here" risk.

**Test counts.** 2109 → 2223 unit tests (+114), 85 → 100
integration (+15). Ten new integration tests for the batch ingest

- sleep-stage aggregation + APNs dispatch + coach-prefs +
  coach-feedback paths plus a 6 000-row chunk-boundary regression
  guard on the BP-in-target analytics path. PROMPT_VERSION ratchets
  4.22.0 → 4.23.0 (one numbered ground rule added: GROUND RULE 12
  "treat Apple Health categories as silent when the snapshot
  doesn't carry them"). Smaller bump than v1.4.22's 4.20.2 → 4.22.0
  because the persona didn't move; only the metric vocabulary did.

**Concerning regressions: none on the surfaces that shipped.**
The new Apple Health enum values are strictly additive (no enum
reorderings, no row mutations, the legacy
`(user_id, type, measured_at, source)` unique index stays). The
APNs scaffolding ships behind absent env-vars — production
without `APNS_KEY_ID` is a no-op rather than a boot failure.
The OpenAPI generator's CI step is `continue-on-error: true` for
this release, so a registry oversight on a non-iOS-touched route
won't red-bar a v1.4.23 PR (intentional — see E.2).

**Tech debt status — the items I named in the v1.4.22 memo**:

1. **Insights page `~9-surface orchestrator`.** Still un-split.
   Held to v1.5 P5. No movement and no regression — the page
   didn't grow in v1.4.23.
2. **Schema drift on `medication_schedules.days_of_week`.**
   **Resolved.** W5 H5 deployed the column (migration
   `0039_medication_schedule_days_of_week`, NULL = daily so
   no backfill needed). Sr-MED-5 is dead.
3. **B1 Vitals tile row.** Still deferred to v1.5 P5 — but
   with a sharper trigger: the tile row replaces the status-
   card list once HRV / Sleep / Resting HR / Steps are
   non-stub, and v1.4.23 just gave us the column shapes to
   write that data into.
4. **`CoachDrawer key={prefill}` weaponising React keys
   (Sr-HIGH-4).** **Resolved.** W5 H3 introduced a
   `useResettableValue` hook + pure `nextResettableValue`
   helper; `key={prefill}` is gone from the parent mount. The
   drawer's prefill is now a fully-controlled prop. Clean
   ground for v1.5 P3 to multiply this pattern into the iOS
   Coach surface.
5. **Pearson p-value normal-approx at low df (Code-MED-03).**
   **Patched, not solved.** W5 H6 raised `MIN_PAIRED_N` from
   14 → 20 — the conservative gate. The rigorous incomplete-
   beta replacement is queued as a v1.4.24 candidate and lands
   before v1.5/v1.6 auto-discovery surfaces correlations
   without a human-curated gate.

Two new items on the watchlist:

6. **OpenAPI registry coverage gap.** The new generator emits
   ~880 lines vs the legacy hand-maintained spec's 5 468; the
   CI gate is `continue-on-error: true` until the registry has
   caught up. The risk is a server-side route signature
   change on a non-registered route lands clean and only
   surfaces when the iOS DTO codegen breaks. **Flip the gate
   to hard-fail in v1.4.24** and complete registry coverage
   in parallel so the lockstep happens before the iOS app is
   downloading the spec automatically.
7. **Coolify auto-deploy still requires the maintainer to flip
   one toggle.** W4 F8 documented the exact recipe — the
   `COOLIFY_WEBHOOK` + `COOLIFY_TOKEN` repo secrets land via
   GH UI, the "Watch image registry for new digests" toggle
   lives in the Coolify dashboard. The CI workflow can
   `::notice::` the deploy timestamp + sha for triage but
   can't flip the registry-watch toggle. If the toggle is
   off, GHCR builds will be green and `/api/version` will
   stay on v1.4.22 silently. **Maintainer action required
   before v1.4.23 tag.**

---

## B. Biggest items shipped in v1.4.23

In priority order:

1. **Apple Health measurement schema + batch-ingest contract
   (W2 F1+F2+F3).** The biggest contract decision of the
   v1.5 lead-up. Seven new `MeasurementType` enum values
   (`HEART_RATE_VARIABILITY`, `RESTING_HEART_RATE`,
   `ACTIVE_ENERGY_BURNED`, `FLIGHTS_CLIMBED`,
   `WALKING_RUNNING_DISTANCE`, `VO2_MAX`, `BODY_TEMPERATURE`),
   `APPLE_HEALTH` joins `MeasurementSource`, a new `SleepStage`
   enum mirrors `GlucoseContext`, and `Measurement` picks up
   nullable `sleepStage` + `externalSourceVersion` columns
   plus a composite unique index
   `(user_id, type, source, external_id)`. Migration
   `0036_apple_health_measurement_types` is strictly
   additive — no row mutations, no rename. The new
   `POST /api/measurements/batch` endpoint accepts ≤500
   entries per call, wraps `withIdempotency()`, returns
   per-entry `inserted | duplicate | skipped` status with a
   typed `reason` field for skips so the iOS sync cursor can
   advance accurately. Sleep-stage aggregation in
   `/api/analytics` rolls multi-stage nights into one Berlin-
   day datapoint with a per-stage breakdown over the trailing
   30 days. Files: `prisma/schema.prisma`,
   `prisma/migrations/0036_apple_health_measurement_types/migration.sql`,
   `src/app/api/measurements/batch/route.ts`,
   `src/lib/measurements/apple-health-mapping.ts`,
   `src/app/api/analytics/route.ts`. Report:
   `phase-W2-v1423-report.md`. **This is the contract the iOS
   app gets to compile against on day zero.**

2. **APNs scaffolding + dispatcher cascade rewire (W3 F4).**
   `@parse/node-apn` is the chosen library (W1 stream-2
   decision). Provider singleton per gateway (sandbox vs
   production), lazy-initialised so JWT signing doesn't run
   at boot, JWT auto-rotates every ~50 minutes inside the
   library. Permanent failures (`Unregistered`,
   `BadDeviceToken`, `DeviceTokenNotForTopic`) drop the dead
   Device row mirroring web-push 410 cleanup. The dispatcher
   cascade order is now an explicit `channelPriority()` sort
   (APNs → Telegram → ntfy → Web Push, unknowns last) so a
   Postgres scan-order change can't reorder delivery between
   deploys. `POST /api/devices` accepts paired `apnsToken` +
   `apnsEnvironment` fields with a 422 when one comes without
   the other; the cross-user-hijack guard from CLAUDE.md is
   duplicated at the APNs-token layer (409 +
   `apns_token_owned_by_other_user` audit reason). Migration
   `0037_apns_device_columns` adds nullable columns plus a
   paired CHECK constraint. Files:
   `src/lib/notifications/senders/apns.ts` (new),
   `src/lib/notifications/dispatcher.ts`,
   `src/app/api/devices/route.ts`. Report:
   `phase-W3-v1423-report.md`.

3. **OpenAPI 3.1 generator + drift gate (W4 F5).**
   `zod-openapi@5.4.6` reads Zod v4 `.meta()` annotations on
   the existing validation schemas; `yaml@2.8.4` serialises
   with `sortMapEntries: true` so the output is byte-stable
   across runs. The eight v1.5-iOS-critical routes are
   registered now (auth/login, passkey verify, refresh,
   measurements GET + POST + batch, devices POST, insights
   comprehensive); the legacy hand-maintained spec is
   preserved at `docs/api/openapi-v1422-legacy.yaml` so iOS
   DTO reference doesn't disappear during the organic
   catch-up. CI step diffs generated vs committed; warn-only
   for v1.4.23, hard-fail in v1.4.24+. Files:
   `src/lib/openapi/registry.ts`, `src/lib/openapi/routes.ts`,
   `docs/api/openapi.yaml`, `.github/workflows/security.yml`.

4. **Per-device refresh-token reuse-detection + device
   management endpoints (W4 F7).** Pre-1.4.23 a refresh-token
   replay revoked every refresh token the user owned —
   correct for security but a foot-gun for a two-device
   household. v1.4.23 scopes the blast radius to the
   originating `deviceId`; legacy null-deviceId tokens fall
   back to the wider revoke (safety hatch). Three new
   routes: `GET /api/auth/me/devices` lists devices with
   label, `lastSeen`, `channels` (`web_push` / `apns`),
   `isCurrent` marker; `DELETE /api/auth/me/devices/[id]`
   revokes a device + its refresh + access tokens + the row;
   `DELETE /api/devices/[id]` is the native-friendly mirror
   the iOS APNs-rotation flow calls. Cross-user attempts
   return 404 with no enumeration leak. Files:
   `src/lib/auth/refresh-rotate.ts`,
   `src/app/api/auth/me/devices/route.ts`,
   `src/app/api/auth/me/devices/[id]/route.ts`,
   `src/app/api/devices/[id]/route.ts`.

5. **Coach Apple Health schema slot + PROMPT_VERSION 4.23.0
   (W4 F6).** The strict insight schema's `sourceMetric` and
   `trendAnnotations` enums extend to admit nine additive
   HealthKit categories (hrv, sleep, resting_hr, steps,
   active_energy, flights, distance, vo2_max, body_temp).
   The Coach snapshot pipeline queries the new measurement
   types only when scope toggles them on — web-only accounts
   pay zero extra SQL. PROMPT_VERSION 4.22.0 → 4.23.0 with
   GROUND RULE 12 (EN + DE): treat Apple Health categories as
   silent when the snapshot doesn't carry them. No
   "you're missing HRV data" apologetic openers. Files:
   `src/lib/coach/prompts/coach-prompt.ts`,
   `src/lib/ai/schema.ts`, `src/lib/coach/snapshot.ts`.

6. **Hygiene wave (W5 H1-H7, 8 commits).** Seven backlog
   items from `.planning/v1422-backlog.md` shipped as atomic
   commits. Notables: the `<CoachDrawer>` controlled-prop
   refactor (Sr-HIGH-4 closed with `useResettableValue` hook
   - pure helper), the analytics-route unbounded `findMany`
     replaced with cursor-paged 5 000-row chunks (Sr-M1 closed,
     `analytics.bp_in_target.row_count` wide-event meta added
     for slow-query attribution), the per-user Coach prefs
     surface (Coach settings cog returns; `User.coachPrefsJson`
     migration `0038_coach_prefs`; system-prompt prepends a
     per-user OVERRIDE; `excludeMetrics` filters BEFORE the
     snapshot lands so the snapshot doesn't carry data the user
     asked to keep out), the per-message thumbs feedback loop
     (`RecommendationFeedback.target_type` polymorphic
     migration `0040_recommendation_feedback_target_type`; new
     `POST /api/insights/chat/messages/:id/feedback`; admin
     aggregator slice at `/admin/coach-feedback` rendering
     buckets sliced by promptVersion × tone × verbosity). Report:
     `phase-W5-v1423-report.md`.

---

## C. v1.5 P1 (iOS first launch) — refreshed plan with concrete file paths

The v1.4.22 memo defined P1 in broad strokes: "Smallest
deliverable that proves bearer + refresh-token end-to-end: one
login page, one dashboard widget." v1.4.23 shipped every
server-side contract that plan assumed. P1 is now smaller than
the v1.4.22 memo described, because what was three or four
"must-build" backend items in P1 is now zero.

### What v1.4.23 already gave the iOS app

- `POST /api/auth/login` with `X-Client-Type: native` returns
  `{token, refreshToken, expiresAt, deviceId}` — already shipped
  in v1.4 (CLAUDE.md headless-client section), unchanged in
  v1.4.23.
- `POST /api/auth/refresh` accepting `hlr_*` and returning a
  fresh pair, with per-device reuse-detection (W4 F5 fixed the
  two-device foot-gun).
- `POST /api/devices` accepting `apnsToken` + `apnsEnvironment`
  with cross-user-hijack guard.
- `GET /api/auth/me/devices` for the iOS Settings → Devices tab.
- `DELETE /api/devices/[id]` for the iOS APNs-rotation cleanup
  path.
- `POST /api/measurements/batch` for the future Apple Health sync
  (not P1 itself but P2).
- `GET /api/measurements?from=&to=&type=` — already shipped in
  v1.4 for the web app, no v1.4.23 changes needed.
- `docs/api/openapi.yaml` regenerates from
  `src/lib/openapi/routes.ts` and covers all eight P1-touched
  routes (W4 F5). The iOS DTO codegen has a stable target.

### What P1 is on the iOS side (~5 days)

The iOS handoff at `~/Projects/healthlog-iOS/HealthLogIOS/HealthLog/`
already has `Services/APIClient.swift` (286 lines),
`Services/AuthService.swift` (232 lines),
`Services/KeychainStore.swift` (108 lines), and
`Models/MeasurementDTO.swift` (246 lines) scaffolded. P1 is
wiring those services to a single login screen, a single
dashboard view, and a single widget extension.

**Concrete file-path-level work on the iOS side:**

1. **Login screen at
   `~/Projects/healthlog-iOS/HealthLogIOS/HealthLog/Screens/Auth/LoginView.swift`
   (new — directory is currently empty).** Email/password form.
   Calls `AuthService.login(email:password:)` which already
   exists in `Services/AuthService.swift` and is already wired
   to `POST /api/auth/login` with `X-Client-Type: native`. On
   success: store both `token` (`hlk_*`) AND `refreshToken`
   (`hlr_*`) in `KeychainStore` (`Services/KeychainStore.swift`
   already has the API for this — `setAccessToken(_:)` /
   `setRefreshToken(_:)` per the 108-line scaffold). On 401:
   surface the localised error via `AuthService.AuthError`.
   Passkey login is punted to P3 — the WebAuthn ceremony +
   `PasskeyService.swift` exist but the iOS passkey UX needs a
   dedicated wave (Apple's `ASAuthorization` flow is its own
   five-step dance).

2. **Dashboard view at
   `~/Projects/healthlog-iOS/HealthLogIOS/HealthLog/Screens/Dashboard/DashboardScreen.swift`
   (already exists as a stub).** Single SwiftUI view rendering
   today's BP + weight + mood from
   `GET /api/measurements?from=<midnight>&to=<now>&type=BLOOD_PRESSURE_SYS,BLOOD_PRESSURE_DIA,BLOOD_PRESSURE_PULSE,WEIGHT,MOOD`.
   The query takes a comma-separated `type` parameter — already
   shipped in v1.4. `APIClient.swift`'s 401 → refresh chain
   (lines ~120-180 per the 286-line scaffold) handles token
   rotation transparently. Data lands as `MeasurementDTO`
   (`Models/MeasurementDTO.swift`). Three labelled rows: BP
   `132/86 · 72 bpm`, Weight `81.2 kg`, Mood `😊 Gut`. No
   chart, no streak, no Coach button — those are P3+.

3. **Widget extension at
   `~/Projects/healthlog-iOS/HealthLogIOS/HealthLogWidgets/LatestVitalsWidget.swift`
   (new — directory exists, empty).** Lock-Screen rectangular
   widget showing the same three rows as the dashboard. Reads
   the cached payload via `WidgetCenter.shared` shared App
   Group (`group.dev.healthlog`). Refresh policy: every 30
   minutes via `TimelineProvider`. The widget never calls the
   API directly — that would burn the user's bearer token in
   the widget process, which has its own Keychain access scope
   pain. The dashboard view writes the latest payload to the
   shared App Group on every fetch; the widget reads from
   there. If the cache is empty, the widget shows
   "Open HealthLog" copy.

4. **Device registration on first successful login.** After
   login lands the bearer token, `AuthService` requests APNs
   permission via `UNUserNotificationCenter`, captures the
   `deviceToken` from the AppDelegate's
   `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`
   callback, hex-encodes it via
   `data.map { String(format: "%02x", $0) }.joined()` (NOT
   `data.description`, which renders `<deadbeef cafebabe>`
   with spaces — see W3 #1 open question), and `POST
/api/devices` with `{apnsToken, apnsEnvironment}` where
   `apnsEnvironment` is `"sandbox"` for `#if DEBUG` and
   `"production"` otherwise. The 409 cross-user-hijack guard
   means an iPhone passed between two HealthLog accounts
   can't redirect pushes — the previous owner deletes the
   device first via `DELETE /api/auth/me/devices/[id]` from
   their Settings tab. P1 doesn't need to surface the device
   list yet — that's P3 alongside passkey.

**Server-side files touched in P1: zero.** Every contract is
locked. The only adjacent server change v1.4.24+ might land is
flipping the OpenAPI drift gate from warn-only to hard-fail
once the iOS DTO codegen has a confirmed working pipeline
against the v1.4.23 spec.

**Risk surface for P1 specifically (down from v1.4.22's two
risks to one):** Cert-pinning is empty in the iOS production
scheme per the iOS handoff's Phase 1 doc. Wire before first
TestFlight build. A missed pin update on Cloudflare cert
rotation bricks every device. The two-device-foot-gun risk
v1.4.22 named is now dead — W4 F5 fixed it.

### Cross-link to the consolidated 13 iOS DTO open questions

Every Wave 2/3/4 report ended with maintainer-facing open
questions about the iOS contract. W4's report consolidated all
13 in one section (`phase-W4-v1423-report.md` lines 137-199).
Routing each to a v1.5 phase:

**P1 (iOS first launch — login + dashboard + widget):**

- Q6 (W3 #1) **APNs token wire format = hex-join, no
  `data.description`** — must land in the AppDelegate's
  registration callback. Catches at 422 if the iOS
  serialiser is wrong; clean fix in `LoginView.swift`'s
  post-auth flow.
- Q7 (W3 #2) **`apnsEnvironment` = sandbox in Debug,
  production in Release** — locked at the
  `#if DEBUG`/`#else` site in the registration code; not a
  runtime decision.
- Q12 (W4 NEW) **`X-Device-Id` header on
  `GET /api/auth/me/devices`** — `APIClient` adds a default
  header from `KeychainStore.deviceId` for that route family.
  Already done for `/api/auth/refresh` per the 286-line
  scaffold.

**P2 (Apple Health sync + measurement-source taxonomy):**

- Q1 (W2 #1) **Source enum rename
  `HEALTHKIT` → `APPLE_HEALTH`** — the iOS DTO at
  `~/Projects/healthlog-iOS/HealthLogIOS/HealthLog/Models/MeasurementDTO.swift:60`
  still ships `case healthKit = "HEALTHKIT"`. One-line rename
  - sim-data reset note in the iOS dev README. Land before
    first TestFlight build that posts to `/api/measurements/batch`.
- Q2 (W2 #2) **`externalId` = `HKSample.uuid.uuidString`
  verbatim**, NOT a composite — protects dedup across
  iCloud-paired devices.
- Q3 (W2 #3) **`sleepStage` = numeric codepoint**, not string
  label. Server accepts 0-20; iOS-16+ documented codepoints
  are 0-5; headroom is for Apple's future additions.
- Q4 (W2 #4) **No pre-conversion on the wire** — server
  expects Apple's native units (0..1 fraction for SpO2/body
  fat, kcal for active energy). Double-multiplying lands SpO2
  at 9 700.
- Q5 (W2 #5) **Unknown identifier behaviour = park-for-retry**
  on the iOS side, not drop-from-cursor. A server-side
  mapping addition then automatically backfills.

**P3 (Coach extended for new metrics + iOS Coach surface):**

- Q9 (W3 #4) **Multi-device cascade behaviour** — UX call:
  two paired iPhones produce two notifications (matches
  iCloud iMessage), or do we ship a "primary device" toggle?
  The Coach surface multiplies this — every Coach reply
  triggers the cascade. Decide before P3.
- Q10 (W3 #5) **`collapseId` shape** — server uses
  `eventType` today; embed `medicationId` for per-medication
  collapsing if the iOS UX wants two simultaneous reminders
  for two different meds visible. Decide before P3 because
  the Coach surface adds new event types.
- Q11 (W4 NEW) **Device-list channel rendering** — UI
  decision: chips for both `web_push` + `apns` per device, or
  filter to the platform-matching channel only? The iOS
  Settings tab in P3 settles this.
- Q13 (W4 NEW) **Refresh + device-deletion race handling** —
  iOS client should treat 401-after-delete as a re-login
  signal, not a transient. The 401 handler in
  `APIClient.swift` already bounces to `LoginView` per the
  scaffold; confirm the path covers the post-delete case.

**P4 (per-metric APNs alerts):**

- Q8 (W3 #3) **Token rotation cadence** — iOS client should
  call `DELETE /api/devices/[id]` on observed APNs rotation +
  re-register, rather than relying on the server's
  `Unregistered` cleanup alone. The endpoint is wired; the
  iOS observer needs to call it.

The 13 questions span four phases. P1 only touches three. The
iOS Swift code lands answers as it lands; nothing on the
server side blocks the answer.

---

## D. v1.5 P2-P6 — minor adjustments based on what v1.4.23 learned

The v1.4.22 memo described P1-P6. v1.4.23 didn't invalidate any
of that plan; it sharpened P2 and P4's shape and dissolved the
P5 page-split prerequisite from "blocked on Apple Health work"
into "blocked on Apple Health DATA, not Apple Health SCHEMA".

### Phase P2 — Apple Health sync (~5 days, was 6-7)

**Down a day** because the schema work landed in v1.4.23 W2.
What's left for P2:

- iOS: `HealthKitService.swift` (already exists, 232-line
  scaffold per the iOS handoff `Services/` listing) wires
  `HKObserverQuery` for live updates +
  `HKAnchoredObjectQuery` for incremental sync. Anchor stored
  in `KeychainStore`.
- iOS: `Services/SyncCoordinator.swift` (new) batches anchor
  delta into ≤500-entry calls to `POST /api/measurements/batch`,
  reads per-entry status, advances the cursor past `inserted`
  AND `duplicate`, surfaces `skipped` for diagnostics.
- iOS: Sim-data reset + DTO rename per W2 Q1.

Server side: zero new endpoints, zero migrations. The
`apple-health-mapping.ts` already covers all nine HealthKit
identifiers W1 enumerated. If iOS posts a new identifier we
haven't mapped, the server returns
`skipped`/`unmappable_identifier` and the iOS sync cursor
parks the sample for the next server release per Q5.

### Phase P3 — Coach + Daily Briefing extended for new metrics (~4 days, was 5)

**Down a day** because W4 F6 already landed the schema slot +
GROUND RULE 12. PROMPT_VERSION 4.23.0 already accepts the nine
HealthKit categories. The remaining P3 work:

- Prompt rules for HRV trends, sleep windows, resting HR,
  steps as context-not-prescription. Each lands as a
  numbered ground rule and ratchets PROMPT_VERSION 4.23.0 →
  5.0.0 (major bump because the persona's responsibility
  surface widens by half).
- Source-chip i18n bundles already partially landed in W4 F6;
  remaining keys (`insights.coach.metric.{hrv,sleep,
restingHr,steps,activeEnergy,flights,distance,vo2Max,
bodyTemp}` × EN + DE).
- iOS Coach surface — copy the web's `<CoachDrawer>` UX
  pattern. The W5 H3 controlled-prop refactor means the iOS
  Swift port doesn't inherit the `key={prefill}` antipattern
  v1.4.22 carried.
- Conversation-eviction policy from D.4 of the v1.4.22 memo
  (auto-archive after 90d, hard-delete after 365d). The iOS
  app multiplies Coach volume 3-5×; this is the right window
  to land it before the worker re-architecture in v1.6.

### Phase P4 — Per-metric APNs alerts (~3 days, was 4-5)

**Down a day or more** because the entire send-side scaffold
landed in W3 F4. What's left for P4:

- Per-event opt-out in the iOS Settings tab — already routes
  through the existing `NotificationPreference` model.
- Background `apns-push-type=background` push for the
  HealthKit observer-query wake hook (W3 explicitly deferred
  this from v1.4.23).
- Per-device-token mute (silence APNs on one phone but not
  the other) — adds a `Device.mutedAt` column or a join row,
  decide based on whether iOS ships a multi-device user.
- TestFlight smoke + production-gateway pivot test.

The two real risks I named in the v1.4.22 memo for P4 (sandbox
vs production gateway, rate-limit at the sender) are now
inherited by `@parse/node-apn`'s Provider abstraction —
proven library, not hand-rolled HTTP/2.

### Phase P5 — Web app polish + v1.5 release brief (~4 days, unchanged)

**Plan unchanged**, with one sharpening. The Insights page
split — the ~9-surface orchestrator — was held to P5 in the
v1.4.22 memo on the rationale that splitting before knowing
which sub-trees Apple Health touches risks re-splitting twice.
v1.4.23 didn't touch the Insights page (deliberately). P5's
split now has a concrete map: the new Vitals tile row replaces
the status-card list in the hero region; the existing
correlations row absorbs the optional HRV/sleep correlations;
the Daily Briefing row gains an optional sleep-debt panel.
Sub-tree boundaries are visible from the schema work.

### Phase P6 — Cross-user feedback aggregation cron (~3 days, parallelisable, unchanged)

**Plan unchanged**, with one sharpening. v1.4.23 W5 H7 shipped
the per-message thumbs feedback loop + the
`/admin/coach-feedback` aggregator slice already buckets by
(promptVersion, tone, verbosity). The P6 cron is now "wire
the existing aggregator to a daily pg-boss schedule + append
OMIT/REPHRASE rules to PROMPT_VERSION when a bucket's
helpful-rate drops below 50%". The aggregator code exists; the
cron + rule-append loop is the new work.

---

## E. Risks / Tech-Debt watchlist

1. **Coolify auto-deploy still requires a maintainer toggle.**
   W4 F8 documented the recipe + added the `::notice::` log
   line, but the "Watch image registry for new digests"
   toggle in the Coolify UI cannot be flipped from CI. If the
   toggle is off after v1.4.23 tag, GHCR builds will be green
   and `/api/version` will silently stay on v1.4.22. **Action
   before v1.4.23 tag:** confirm the toggle is on, run the
   verification recipe (`curl /api/version | jq
.data.version`) on first deploy, document the host-side
   fallback if the toggle drifts off again. The v1.4.21
   release went out via a host-side fallback for the same
   reason — the second time the same thing breaks the same
   way means the runbook is fragile.

2. **OpenAPI drift gate is warn-only for v1.4.23.** The
   generator covers ~880 lines; the legacy hand-maintained
   spec is 5 468 lines. A server-side route signature change
   on a non-registered route lands clean today and only
   surfaces when the iOS DTO codegen breaks. **Flip to
   hard-fail in v1.4.24** and complete registry coverage in
   parallel. The risk window is "every PR between v1.4.23
   and v1.4.24" — pull v1.4.24 forward if the iOS app starts
   compiling against the spec sooner than expected.

3. **Refresh-token reuse-detection is now per-device, BUT the
   safety-hatch falls back to user-wide for null deviceId
   tokens.** Legacy tokens issued before W4 F5 still trip the
   wide revoke. The fallback is correct (better safe than
   sorry); the cost is that any user who logged in via the
   web before v1.4.23 carries null-deviceId refresh tokens.
   **Acceptable**: the wide revoke for legacy tokens only
   bites on a replay attempt, which is the security signal we
   want. Worth a watchlist entry so a future audit doesn't
   delete the fallback as "dead code".

4. **The new `safeParse()` sites for HealthKit envelopes.**
   v1.4.22 added one (the sentinel keyValues block);
   v1.4.23's W4 F6 added the schema slot but the prompt
   doesn't yet emit HealthKit data, so the safeParse exposure
   is theoretical. P3's PROMPT_VERSION 5.0.0 bump WILL emit
   real HealthKit envelopes (HRV, sleep, resting HR, steps,
   plus the four secondary metrics). Audit every new
   `safeParse()` call before P3 tag — same lesson as v1.4.17
   hotfix. The sentinel parser observability work in W5 H1
   (typed `SentinelParseResult.malformedEntries[]`) is the
   right pattern; the new HealthKit envelopes should reuse
   the same partial-malformed surface.

5. **Coach token-budget cap is a soft wall and the iOS
   surface multiplies it.** 25 000 tokens/user/day at
   ~1 800 tokens/turn = ~13 turns. The HTTP 429 is correct
   but the iOS UX needs a clear "you've reached today's
   Coach limit; resets at 00:00 UTC" message rather than a
   generic error toast. v1.5 P3 work — the iOS Coach surface
   makes this more visible than the web-only surface today.
   Carries forward from the v1.4.22 memo unchanged.

6. **The "summarise older half" pass is still a placeholder.**
   The B2a history-window builder injects a synthetic
   `[summary placeholder — N earlier turns elided]` line
   rather than calling a provider for a real summary. v1.5 P3
   if usage data shows it matters. The W3 sentinel pattern
   gives us a cheap real-summary now: feed the older half's
   prose + sentinel rows to a small-model summary call.
   Carries forward from the v1.4.22 memo unchanged.

7. **Coach helpful/unhelpful first-week observation window
   opens on v1.4.23 tag.** W5 H7's `/admin/coach-feedback`
   aggregator answers "is the v1.4.22 prose rewrite landing
   well, or did the warm tone overshoot?" If the helpful-rate
   for PROMPT_VERSION 4.23.x drops below 50% within the first
   100 ratings, v1.4.24 walks the persona back. **Watch the
   admin dashboard daily for the first week post-tag.**

8. **The Pearson surfacing-gate raise (n≥14 → n≥20) means
   some borderline correlation cards STOP rendering after
   v1.4.23 tag.** W5 H6's conservative patch trades
   false-positives for false-negatives. If the v1.4.16 B5e
   feedback aggregator shows users miss those cards, drop in
   the rigorous incomplete-beta replacement in v1.4.24 (queued
   as the follow-up).

---

## F. Candid one-liner

v1.4.23 is the foundation release nobody outside this `.planning/`
directory will notice — Apple Health schema, APNs scaffold,
OpenAPI generator, per-device refresh-token revocation, Coach
prefs cog, helpful/unhelpful feedback loop — and that's exactly
what makes v1.5 P1 a five-day iOS Swift sprint instead of a
three-week server-and-iOS sprint where the contract changes mid-
flight.
