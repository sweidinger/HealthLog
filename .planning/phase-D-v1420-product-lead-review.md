# v1.4.20 — Product-Lead Review

Author: Marc (strategic memo to self)
Date: 2026-05-10
Status: pre-release of v1.4.20; Wave-B (B1–B5) landed on `develop`,
Wave-D reviewers (code, security, design, senior-dev, simplify) in
flight; v1.4.19 live since the morning. This memo updates
`.planning/phase-D-v1419-product-lead-review.md`. Same audience:
Marc-three-weeks-from-now. The question this version answers:
**what state is the app in after the v1.4.20 Insights redesign + AI
Coach landed, and what does v1.5 — the iOS app + Apple Health
integration — actually need to be?**

---

## A. State of the App after v1.4.16 → v1.4.17 → v1.4.18 → v1.4.19 → v1.4.20

The arc is clear now. **v1.4.16** was the polish-leap that
overshot. **v1.4.17** was the schema-strictness hotfix. **v1.4.18**
walked back the visual overshoots and grew Achievements into a real
engagement surface. **v1.4.19** was the deliberately-boring polish
release that lined up the runway: 4th-attempt bugs (BD-Zielbereich,
api-tokens scrollbar) finally closed, the
`<IntegrationStatusPill>` and `<TruncatedCell>` primitives ready to
plug into the next surface. **v1.4.20 is the deliberately-loud
product release** that cashes that runway in. Five sequential B-
phases shipped on `develop` against `~/Downloads/design_handoff_
insights_redesign`'s seven artboards: a redesigned Insights hero,
a Daily Briefing card, suggested-prompt chips, an AI Coach drawer
with SSE streaming and encrypted persistence, three pre-defined
correlation cards, AI-annotated Trends row, a printable Weekly
Report route, storyboard annotations on the BP chart, and a
deterministic Personal Health Score panel.

**Quality bar trajectory: still rising, slope steepening — first
time in five releases.** v1.4.16 was a step-function up that walked
back; v1.4.17/18/19 were the recovery taper; v1.4.20 is a real
step-function up that sticks because every piece either replaces
something already there (hero, status) or adds an opt-in surface
(Coach drawer, Weekly Report). The polish-vs-feature ratio inverted
back to ~30/70 — the right ratio for a release that means to ship
new product.

**Test counts moved hard.** 1672 → 2026 unit tests (+354 net), 67 →
81 integration (+14). Five new Prisma models — `CoachConversation`,
`CoachMessage`, `CoachUsage` — under one migration `0035_coach_
conversations_v1420`, AES-256-GCM encrypted message bodies via the
existing `crypto.ts`, GDPR cascade wired through the FK chain. New
prompt versions on a controlled ratchet (4.19.0 → 4.20.0 → 4.20.1
→ 4.20.2) — every bump carries one new schema block so legacy
caches `safeParse` to null instead of crashing. The v1.4.17 lesson
is wired into every new payload by construction now, not by audit.

**Concerning regressions: none I can name yet.** Wave-D reviewers
are still landing findings (`.planning/phase-D-v1420-*` files not
yet on disk at memo-write time), but the per-phase reports already
flagged the items I'd flag myself: schema drift on
`medication_schedules.days_of_week` (`select`-clause workaround in
the analytics route), the Coach summarisation placeholder for
conversations >20 turns, and a desktop drawer width (`1080px`) that
might want to drop sources rail at `lg` and only paint it at `xl+`.
None of these block the tag.

**Accumulated tech debt to watch.** Three live items:

1. The Insights page (`src/app/insights/page.tsx`) is now an
   orchestrator for ~9 distinct surfaces (hero, briefing,
   correlations, trends, advisor, recommendations, charts, coach
   drawer, score panel). The component is unsplit; the senior-dev
   review will likely flag it. Defer to v1.4.21 — splitting before
   the multi-agent QA runs is premature.
2. Schema drift on `medication_schedules.days_of_week` exists in
   `schema.prisma` without a corresponding migration. v1.4.20 worked
   around it twice (B5 analytics, B2a coach snapshot). v1.4.21
   should either deploy the column or drop it from the schema.
3. The B1 Vitals tile row was deliberately deferred — the per-
   section status cards already render the same numbers. The four-
   tile artboard layout will only land when B3's trends row
   reorganises the per-section blocks. Tracked in `.planning/v1421-
backlog.md`. Not urgent; the briefing fills the role.

---

## B. Biggest items shipped in v1.4.20

In priority order:

1. **AI Coach drawer + streaming chat + encrypted persistence (B2).**
   The biggest piece. `POST /api/insights/chat` is an SSE endpoint
   that walks the existing v1.4.16 provider chain, persists user +
   assistant turns under AES-256-GCM, and emits `token` →
   `provenance` → `done` frames. Per-(user, UTC-day) token ledger
   in `CoachUsage` caps the day at 25 000 tokens (≈13 turns for a
   heavy user). Refusal scanner blocks prompt-injection and obvious
   off-topic asks (EN+DE patterns) with a health-allow-list short-
   circuit. `parseSseChunk()` is exported separately so the
   streaming parser is unit-testable without a live network — full
   coverage on single-frame, multi-frame, byte-by-byte interleaving,
   malformed payload, round-trip. Drawer mounts from the hero
   strip's "Ask the coach" button and from suggested-prompt chips;
   `key={prefill}` on `<CoachDrawer>` sidesteps `react-hooks/set-
state-in-effect` so the lazy `useState` initialiser fires fresh
   on every chip transition. **This is the feature that defines
   v1.4.20** — every other piece of the redesign supports it. Files:
   `src/app/api/insights/chat/route.ts`, `src/lib/ai/coach/*`,
   `src/components/insights/coach-panel/*`. Reports:
   `phase-B2a-report.md` (backend) + `phase-B2b-report.md` (drawer).

2. **Daily Briefing + Hero strip + Suggested prompts (B1).** Replaces
   the v1.4.16 `<InsightsPageHero>` with a wider band: locale-aware
   greeting (4 buckets, 03:00 routes to "Good evening"), narrative
   subtitle from `dailyBriefing.paragraph`, three action buttons
   (weekly-report, ask-coach, regenerate), a 5-chip suggested-prompt
   strip, and a full-width Daily Briefing card with 0–5 finding rows
   (each tone-coloured: good/watch/info, with optional delta badge
   - metric icon). Schema bumped: `dailyBriefingSchema` is
     `nullable().optional()` on the response root so 4.19 caches
     round-trip cleanly. PROMPT_VERSION 4.19.0 → 4.20.0 with
     GROUND RULE 8 added to EN+DE prompts. The Vitals tile row from
     the artboard was deliberately deferred — the per-section status
     cards already render the same numbers and a tile row above them
     would duplicate the surface. Files:
     `src/components/insights/{hero-strip,daily-briefing,suggested-
prompts}.tsx`, `src/lib/ai/schema.ts`. Report:
     `phase-B1-v1420-report.md`.

3. **Correlation discovery + Trends row (B3).** Three pre-defined
   hypotheses surface as 2-up Correlation cards: BP × medication
   compliance, mood × resting pulse, weight × weekday. Quality bar
   non-negotiable: `n ≥ 14` paired data points, `p < 0.05`; below
   the bar each card paints `<EmptyState>` rather than a near-zero
   scatter. Pure runners in `src/lib/insights/correlations.ts`
   (Pearson + weekday ANOVA via inline Wilson-Hilferty +
   Abramowitz-Stegun approximations — no new dependencies). 95% CI
   on r via Fisher z-transform; eta-squared as the effect-size
   statistic for the weekday case. `<TrendsRow>` paints a 3-up
   trends grid (BP / weight / mood) with inline AI annotations
   (`trendAnnotations` block, ≤200 chars each, ground rule 9 bans
   causal language). PROMPT_VERSION 4.20.0 → 4.20.1.
   **Auto-discovery is explicitly v1.5/v1.6 work**; this scope
   discipline is what kept the false-positive risk in check. Files:
   `src/lib/insights/correlations.ts`, `src/components/insights/
{correlation-card,correlation-row,trend-annotation,trends-row}.
tsx`. Report: `phase-B3-report.md`.

4. **Weekly Report + Storyboard + Mobile passes (B4).** New route
   `/insights/report/[week]` (printable via `window.print()`,
   Tailwind `print:` variants for A4/Letter, hero banner card "Your
   Week N report is ready" links into it). New `weeklyReportSchema`
   - `storyboardAnnotationSchema` blocks added to the AI response
     root, both `nullable().optional()` for legacy-cache round-trip.
     `<HealthChart>` gained an additive `annotations[]` prop —
     storyboard pins ride between cartesian grid and data lines so
     they read as orientation, not data. `resolveAnnotationPositions`
     maps annotation dates onto bucketed point indices with a 7-day
     snap window. Mobile rail trays for the Coach drawer (history +
     sources rails were desktop-only since B2b; B4 surfaces them on
     `<lg` via two chevron-button triggers anchored to the inside
     edges of the message thread). PROMPT_VERSION 4.20.1 → 4.20.2.
     Files: `src/app/insights/report/[week]/page.tsx`, `src/lib/
insights/week-iso.ts`, `src/components/insights/weekly-report-
view.tsx`. Report: `phase-B4-report.md`.

5. **Personal Health Score panel (B5).** Server-deterministic
   composite of four weighted components: BP-in-target-rate (30%),
   weight-trend-alignment (20%), mood-stability (20%), compliance-
   rate (30%). Null components redistribute proportionally. Bands:
   green ≥75, yellow 50–74, red <50. Mounted on the right side of
   the hero strip, layout flips `flex-col → flex-row` at `lg+`.
   "Ask the Coach" button on the panel passes a pre-filled
   "Why is my health score X out of 100?" prompt, sharing the same
   drawer state with the hero's "Ask the coach" button so only one
   drawer instance ever exists. Pure helpers exposed alongside the
   composite — `linearRegressionSlope`, `coefficientOfVariation`,
   `weightTrendAlignment`, `moodStability` — so any downstream
   consumer can recompute without re-running the route. Files:
   `src/lib/analytics/health-score.ts`, `src/components/insights/
health-score-card.tsx`. Report: `phase-B5-report.md`.

---

## C. v1.5 implementation plan — iOS native client + Apple Health

The handoff at `~/Projects/healthlog-iOS/` is the iOS app. v1.5's
headline is **iOS native client + Apple Health integration**. The
web app gets the API surface it already shipped in v1.4 (bearer
tokens, refresh tokens, idempotency-key — see `~/Projects/
healthlog-iOS/HealthLogIOS/docs/server-changes.md` for the local
diff already applied). Apple Health adds new measurement sources
(HRV, Sleep, Resting HR, Steps, BodyFat, Glucose). The Insights AI
Coach should ingest the new metrics — extend the prompt + schema.

The iOS handoff already lays out 9 phases (P0 done, P1 networking

- auth, P2 design system, P3 onboarding + HealthKit, P4 dashboard,
  P5 capture + meds + mood, P6 charts + insights, P7 settings +
  doctor report, P8 notifications + widgets, P9 polish). My v1.5
  plan is the **server-side counterpart**: what the web app + API
  need to do so the iOS phases land cleanly. Five phases, each ≤7
  days, sequential where they have to be and parallelisable where
  they don't.

### Phase P1 — Apple Health ingest contract + measurement-source taxonomy (~5-7 days)

The single biggest contract decision. The iOS app reads HRV /
Sleep / Resting HR / Steps / BodyFat / Glucose from `HKHealthStore`
and posts them to the server. The server needs to (a) extend the
`MeasurementType` enum to cover the new types, (b) introduce a
`source` field on `Measurement` that distinguishes
`apple-health` / `withings` / `manual` / `mood-log` so duplicates
can be deduped client-side, and (c) accept a batched ingest
endpoint that takes ~hundreds of points per HealthKit anchor
delta.

**Files touched.** New `prisma/migrations/0036_apple_health_
measurements/migration.sql` (+ schema additions for HRV / SLEEP /
RESTING_HR / STEPS / GLUCOSE / BODY_FAT; `Measurement.source`
becomes a non-null enum). New `src/app/api/measurements/batch/
route.ts` (POST, accepts `{ measurements: [...] }` with hard cap
500/req, 1 idempotency-key envelope per batch). New
`src/lib/measurements/source-dedup.ts` for the
`(source, externalId)` uniqueness invariant. Schema docs
regenerated under `docs/api/openapi.yaml` so the iOS DTO codegen
stays in sync (the iOS app's `docs/api-contract.md` already
expects this path).

**Risks.** (1) `MeasurementType` enum expansion is a breaking
change for existing `/api/measurements` consumers — mitigate by
landing the new enum values as additive only and keeping legacy
values intact. (2) Source-dedup edge case: a Withings measurement
that also flows through Apple Health (the Withings → Apple Health
bridge users sometimes enable). The dedup key must be
`(source, externalId)` not `(timestamp, type)` so the same
physical reading with two source labels can be merged at read
time, not blocked at write time. (3) The doctor-report PDF needs
to surface measurement source — a reading from Apple Health that
came from a third-party scale should say so.

### Phase P2 — Coach + Daily Briefing + Health Score extended for new metrics (~4-5 days)

Today's Coach knows BP, weight, pulse, mood, compliance. v1.5 adds
HRV, Sleep, Resting HR, Steps. Extend in three places: (1)
`extractFeatures()` and `src/lib/ai/coach/snapshot.ts` so the
provenance envelope can label-tag the new metric keys; (2) the
prompts in `src/lib/ai/prompts/insight-generator.ts` so the model
knows what units, what windows, what conservative phrasing
applies; (3) the source-chip i18n bundles
(`insights.coach.metric.{hrv,sleep,restingHr,steps}` in EN+DE).
The Health Score formula stays four-weighted for v1.5 — adding a
fifth component would require a band recalibration that isn't
worth the user-side surprise. v1.6 is the right place for an
expanded score.

**Files touched.** `src/lib/ai/extract-features.ts`,
`src/lib/ai/coach/snapshot.ts`, `src/lib/ai/prompts/insight-
generator.ts` (PROMPT_VERSION 4.20.2 → 4.21.0 — note: bump on
v1.5, not v1.4.21, since this is a contract change). Daily
Briefing's `keyFindings` array can already carry HRV / Sleep
findings — no schema change needed, only prompt-rule updates.

**Risks.** Sleep data in particular has well-known interpretation
traps (REM vs Deep vs Core; Apple's classifier vs Withings's
classifier disagrees ~25% of the time). Ground-rule the Coach to
say "your sleep duration" not "your REM sleep" until the data
quality on the latter is verified. Add a unit-test for the prompt
that asserts the model never claims a clinical sleep-stage
conclusion.

### Phase P3 — Per-metric APNs alerts + device registration hardening (~3-5 days)

The web app uses Web Push (VAPID) for the three notification
channels (Telegram, ntfy, Web Push). iOS users should get APNs
direct rather than the web-push fallback. The
`POST /api/devices` endpoint exists in scaffold (the v1.4 native-
client work added the cross-user-hijack guard returning 409 with
`device.register.denied` audit trail per CLAUDE.md), but APNs
sender-side wiring is still v1.5 work.

**Files touched.** New `src/lib/notifications/senders/apns.ts`
(p8-key auth, JWT signing every 50 minutes, JWT pool reuse), new
APNs config row in `Settings` admin section, env block
`APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_KEY` (the .p8 contents).
Per-event opt-out reuse from existing notification-rules.
`docs/api/openapi.yaml` documents the device-registration shape
for the iOS team.

**Risks.** APNs sandbox vs production (the .p8 key picks at the
issuer level — sandbox-vs-prod is a per-payload `apns-push-type`
header decision). Test with TestFlight builds against the
production APNs gateway to confirm. Rate-limit at the sender
(APNs allows ~20 requests/sec per connection without throttling).

### Phase P4 — Web app polish + v1.5 release brief (~3-4 days)

The PWA gets two visible changes in v1.5:

1. **The third hero micro-stat tile finally fills.** Today
   `<HeroStrip>`'s three-tile slot is partially filled (mood +
   pulse from existing data); the third reads "Apple Health:
   coming with iOS app" until v1.5. Once v1.5 ships, web users
   who have an iOS device sync'd see HRV in the third slot. Web
   users without an iOS device see "Connect Apple Health" with a
   link to the iOS App Store listing.
2. **Per-metric storyboard annotations** can include Apple Health
   events. "Apr 28: started 7-day step streak" is a v1.5 story-
   board annotation that wasn't possible before.

Beyond the visible: the Coach drawer's mobile rail trays from B4
need a 393 px Playwright pass once HRV is real data, not a stub.
The Vitals tile row from B1 (deferred to B3, then v1.4.21, now
v1.5) finally lands on top of the per-section status cards once
HRV / Sleep / Resting HR / Steps are non-stub — at that point the
tile row replaces the long status-card list rather than sits on
top of it, which was the structural blocker in B1.

**Files touched.** `src/components/insights/hero-strip.tsx`,
`src/app/insights/page.tsx`, new `src/components/insights/
vitals-row.tsx`. Release brief in Marc's voice (English, no
"Claude / agent / phase X" leaks per the v1.4.20 retroactive
cleanup directive in `feedback_marc_voice_english.md`). New
`docs/audit/v15-summary.md`.

### Phase P5 — Cross-user feedback aggregation prompt-tuning loop (~3-4 days, parallelisable)

This is the v1.4.16 B5e infrastructure that's been waiting for the
Coach to give it volume. The Coach now generates conversations +
recommendation thumbs at meaningful rate; the aggregator (already
written, just not wired to a daily cron) reads the
`(severity × confidence_band)` buckets and appends OMIT / REPHRASE
rules to the next PROMPT_VERSION when a bucket's helpful-rate
drops below 50%. v1.4.20 didn't wire it because the Coach
conversation surface was still bedding in. v1.5 should wire it on
day one of the milestone — the iOS app will multiply the feedback
volume 3-5x and we want the loop closed before that data lands,
not after.

**Files touched.** `src/lib/jobs/feedback-aggregator-cron.ts`
(daily 04:00 Europe/Berlin, pg-boss queue), `src/lib/ai/prompts/
prompt-version-manager.ts` for the auto-bump path. Same
PROMPT_VERSION channel: 4.21.x → 4.21.x+1 on each rule append.

**Parallelisable** with P1, P2, P3, P4 — no shared file paths.

---

## D. Strategic items NOT in the iOS handoff but relevant to v1.5

Six items that aren't on the iOS roadmap but should ride alongside:

1. **Coolify image-digest auto-deploy (deferred since v1.4.16 →
   v1.4.17 → v1.4.18 → v1.4.19 → v1.4.20).** Still on git-push
   trigger. The 5-min Marc-side UI toggle is fast wins per release
   and pairs with v1.5's larger build matrix. Flip it.

2. **Native ARM runner matrix for `docker-publish`.** v1.4.16
   dropped arm64 due to qemu-arm64 SIGILL; native
   `ubuntu-24.04-arm` runner re-adds it. Pairs with v1.5 because
   the iOS team's developer machines are Apple Silicon — local
   docker images for parity testing should be arm64-native.

3. **Schema drift cleanup on `medication_schedules.days_of_week`.**
   v1.4.20 worked around it twice. v1.5 should land the missing
   migration OR drop the column from `schema.prisma` — the
   work-around `select` clauses become tech-debt as more queries
   touch the table.

4. **Conversation persistence eviction policy.** Coach storage
   shipped in v1.4.20; the eviction policy is v1.5 work. Auto-
   archive conversations after 90 days (move `messages` to a cold
   table, keep the `conversation` row as a stub for the rail);
   hard-delete after 365 days. ~500 KB/user/month at 20 turns × 50
   conversations is tolerable today but needs the policy before
   the iOS app multiplies volume.

5. **Correlation FDR-control for v1.5/v1.6 auto-discovery.**
   v1.4.20's 3-hypothesis scope sidesteps multiple-comparison
   correction; v1.5/v1.6's auto-discovery surface needs Benjamini–
   Hochberg or similar before shipping. Not in v1.5 directly, but
   v1.5 is the right release to start prototyping the math against
   the now-richer Apple Health metric pool.

6. **Settings/Integrations: `<IntegrationCard>` shell extraction.**
   Withings and Mood Log card chrome are duplicated verbatim
   (header row → divider → body). v1.5's Apple Health card will
   copy-paste the same shape a third time. Extract
   `<IntegrationCard>` alongside the existing
   `<IntegrationStatusPill>` before the third copy lands.
   (`.planning/v15-backlog.md` D-SR-H-3.)

---

## E. Risks / Tech-Debt watchlist

1. **The Coach's token-budget cap is a soft wall.** 25 000 tokens/
   user/day at ~1 800 tokens/turn = ~13 turns. Heavy iOS users on
   long road trips ("I want to think out loud about my health for
   30 minutes") will hit the cap. The HTTP 429 is correct but the
   UX needs a clear "you've reached today's Coach limit; resets at
   00:00 UTC" message rather than a generic error toast. v1.5's
   Coach surface on iOS makes this more visible than the web-only
   surface today.

2. **The "summarise older half" pass is a placeholder.** The B2a
   history-window builder injects a synthetic
   `[summary placeholder — N earlier turns elided]` line rather
   than calling a provider to produce a real summary. Cheap and
   deterministic; an opt-in real-summarisation pass can land
   alongside v1.5 once the drawer UI shows whether users actually
   push past 20 turns. Track in usage data first.

3. **Apple Health absence still partly visible in v1.4.20.** The
   hero's third micro-stat tile will read "Apple Health: coming
   with iOS app" until v1.5 ships. Honest; not embarrassing. The
   risk is that v1.5 slips and the placeholder lives on the
   production hero for longer than advertised. Mitigation: ship
   v1.5 by the date-card said in `~/Projects/healthlog-iOS/
HealthLogIOS/.planning/ROADMAP.md`. If it slips by more than 2
   weeks, revisit the placeholder copy.

4. **OpenAPI spec drift between server and iOS DTOs.** The iOS app
   reads `docs/api/openapi.yaml` from the server repo (per
   `docs/api-contract.md`); a server-side route signature change
   that doesn't update the spec will only get caught at iOS-side
   DTO codegen time. Mitigation: a CI check on the server repo
   that diffs the routes against the spec on every PR. Pull this
   forward to v1.4.21 if possible — it's cheaper than discovering
   drift via an iOS build break.

5. **Bearer-token / refresh-token UX on iOS at 401.** The iOS app
   keychain holds the access token + refresh token; a 401 triggers
   re-auth via the refresh endpoint. The reuse-detection on
   refresh tokens (revokes every refresh token for the user when
   the same token is replayed — see CLAUDE.md headless-client
   section) is a real foot-gun if a user ever has two iOS devices
   with the same account. Document this in the iOS onboarding
   ("only one active device per account") and add an
   `/api/auth/me/devices` endpoint for the iOS Settings tab to
   show which device is the primary so the user can intentionally
   move it. v1.5 P3 work.

6. **Insights page (`src/app/insights/page.tsx`) is now an
   orchestrator for ~9 distinct surfaces.** The senior-dev review
   for v1.4.20 will likely flag this. Defer the split to v1.4.21
   — premature splits before knowing which sub-trees the v1.5
   Apple Health work will edit risk re-splitting twice. Mark in
   the v1.4.21 backlog.

7. **`safeParse()` legacy-payload pattern carries forward.** The
   v1.4.20 schema ratchet (4.19.0 → 4.20.2) added four new
   `safeParse()` call sites: `dailyBriefingSchema`,
   `trendAnnotationsSchema`, `weeklyReportSchema`,
   `storyboardAnnotationSchema`. Each falls back to null on schema
   miss, which is correct. The risk: the next prompt bump (4.20.x
   → 4.21.0 in v1.5 P2) might introduce a schema where null isn't
   the safe fallback. Audit every new `safeParse()` call before
   tag — same lesson as v1.4.17 hotfix.

---

## F. Candid one-liner

v1.4.20 is the loudest release in the v1.4.x line — Coach drawer +
streaming + Daily Briefing + correlations + Weekly Report + Health
Score all landed clean against the artboard, and the placeholders
on the hero are the iOS-shaped runway for v1.5 to fill rather than
embarrassments to hide.
