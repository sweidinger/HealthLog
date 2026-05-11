# v1.4.22 — Product-Lead Review

Author: Marc (strategic memo to self)
Date: 2026-05-10
Status: pre-release of v1.4.22; W2 Insights polish + W3 Coach
rewrite + W4 cleanup all on `develop`. W5 multi-agent review in
flight (this memo is the product-lead leg). v1.4.21 went out the
door yesterday; v1.4.22 is the next tag. This memo updates
`.planning/phase-D-v1420-product-lead-review.md`. Same audience:
Marc-three-weeks-from-now. The question this version answers:
**what state is the app in after v1.4.22 closed the polishing
arc, and what does v1.5 — the iOS native client + Apple Health
integration — actually need to be?**

---

## A. State of the App after v1.4.16 → v1.4.17 → v1.4.18 → v1.4.19 → v1.4.20 → v1.4.21 → v1.4.22

The arc is seven releases long and the shape is finally
unambiguous. **v1.4.16** was the polish-leap that overshot.
**v1.4.17** was the schema-strictness hotfix. **v1.4.18** walked
back the visual overshoots and grew Achievements into a real
engagement surface. **v1.4.19** was the deliberately-boring polish
release that lined up the runway for v1.4.20. **v1.4.20** was the
deliberately-loud product release: Coach drawer + streaming +
Daily Briefing + correlations + Weekly Report + Health Score all
landed clean against the artboard. **v1.4.21** was a five-commit
e2e-stability fix wave to unblock the public smoke-check before
more product weight landed. **v1.4.22 is the long-tail polish
release that closes loops we've been carrying since v1.4.16.**

The cadence is now a real two-beat rhythm: a loud release lands
a new product surface, and 1–2 patch releases tighten what that
release exposed before more weight goes on top. The Coach
surface bedded in for two releases before v1.4.22 came back to
rewrite its prose — the right sequencing.

**Quality bar trajectory: a small step-function up on the higher
level v1.4.20 set.** The Coach now talks like a partner instead
of a database cursor (W3), the BD-Zielbereich tile finally feels
like a live metric (W2 A1+A2), the Zielwerte page stopped reading
like a cheat-sheet (W4 C1), and a tail of 12 backlog items got
swept (W4 D).

**Test counts.** 2026 → 2109 unit tests (+83), 81 → 85
integration. New `src/lib/coach/sentinel.ts` parser landed with
18 cases. PROMPT*VERSION ratcheted 4.20.2 → 4.22.0 — the biggest
prompt jump of the v1.4.x line and the first time we've moved
the \_minor* digit, intentional because the persona, the
sentinel-block contract, and the warmth of the prose all changed
in one coherent step.

**Concerning regressions: none on the surfaces that shipped.**
The sentinel-parse path has hard-cap defence-in-depth (1 KB
post-`---KEYVALUES---`, 8 lines max, length-capped Zod per
line); the cookie-mirror onboarding redirect is a UX hint not a
security signal; the api-tokens scrollbar fix is a two-class
deletion with a regression-pin test. The fixes that landed are
small enough to audit by eye.

**Tech debt status — three items I named in the v1.4.20 memo**:

1. **Insights page `~9-surface orchestrator`.** Still un-split.
   v1.4.22 deliberately did not touch it because v1.5's Apple
   Health work edits the same sub-trees and a pre-emptive split
   would re-split twice. **Hold for v1.5 P5.**
2. **Schema drift on `medication_schedules.days_of_week`.**
   Still unresolved; Sr-MED-5 is alive. **Drop or land in
   v1.4.23, latest v1.5 P0.**
3. **B1 Vitals tile row.** Still deferred. v1.5 P5 is when it
   lands — once HRV / Sleep / Resting HR / Steps are non-stub
   data, the tile row replaces the status-card list rather than
   adding a row above it.

Two new items on the watchlist:

4. **`CoachDrawer key={prefill}` weaponising React keys
   (Sr-HIGH-4).** Heavy refactor, not in W4 quick-wins.
   v1.4.23.
5. **Pearson p-value normal approximation at low df
   (Code-MED-03).** At df=12 the normal approx puts true p≈0.04
   at p≈0.025 — generous in the wrong direction. Pull in a
   30-LOC incomplete-beta or raise the surfacing gate to
   df ≥ 20. **Fix before v1.5/v1.6 auto-discovery ships** — the
   false-positive cost compounds with auto-generated
   correlations.

---

## B. Biggest items shipped in v1.4.22

In priority order:

1. **Coach prose rewrite + evidence-block sentinel (W3).** The
   biggest user-facing impact. The Coach used to open every
   reply with a number — clinical, database-cursor energy. W3
   reframes the persona as "warm, neugierig, zurückhaltend": a
   partner sitting alongside the user, not pushing data. Numbers
   move out of the prose into a `---KEYVALUES---` … `---END---`
   sentinel block that the route parses out and renders as a
   collapsible `<details>` disclosure under each assistant turn,
   closed by default and hidden when no key-values came back.
   The persona + sentinel land together because either alone is
   incomplete: warm prose without an evidence block hides the
   data; an evidence block without warm prose is a tooltip.
   Three-way hard caps on the sentinel (1 KB payload, 8 lines,
   per-line Zod) so a prompt-injection attempt can't grow the
   persisted envelope. PROMPT_VERSION 4.20.2 → 4.22.0 — first
   minor-digit bump in v1.4.x. Files: `src/lib/coach/prompts/
coach-prompt.ts`, `src/lib/coach/sentinel.ts` (new),
   `src/components/insights/coach-panel/message-thread.tsx`,
   `src/lib/ai/schema.ts`. Report: `phase-W3-report.md`. **This
   is the feature that defines v1.4.22.**

2. **BD-Zielbereich tile re-anchor + feature parity (W2 A1+A2).**
   Fourth attempt at this metric. v1.4.19 routed the headline to
   `allTime` to fix the algorithmic 50/50/50 pin; v1.4.22
   re-anchors to `last30Days?.pct` and surfaces all-time as a
   sub-row, because v1.4.19's fix was emotionally wrong — the
   headline became the slowest-moving aggregate possible,
   punishing a user who put in real recent work. The tile also
   gets a synthesised trend arrow (slope = `(pct7 - pct30) /
30`), a 7-day-trend chip, and a comparison-overlay caption.
   Shared `<TrendCard>` chrome stays uncompromised: the new
   third sub-value is opt-in via an `avgAllTime` prop that
   defaults to undefined. Files: `src/app/api/analytics/route.ts`,
   `src/components/charts/trend-card.tsx`, `src/app/page.tsx`.
   Report: `phase-W2-report.md`.

3. **Zielwerte page sparkline + Δ-vs-last-month (W4 C1).** The
   target-values page stopped reading like a clinical cheat-
   sheet. Each `<TargetCard>` grew a 30-day inline SVG sparkline
   beneath the range bar plus a localised "Δ −2.3 kg vs. last
   month" caption. The API ships `points30d` + `deltaVsLastMonth`
   per target; both null when either window has fewer than 3
   readings so cold-start accounts don't see a misleading flat
   trace. BMI piggybacks on the weight series so its sparkline
   shares the range bar's y-axis. Direction A from W1a §4 —
   lowest-effort, highest-payoff. Direction C (storyline framing
   with hero cards for the most-out-of-target metrics) is the
   v1.6 product call. Files: `src/app/api/insights/targets/
route.ts`, `src/components/insights/target-card.tsx`,
   `src/app/__tests__/targets-sparkline.test.tsx` (new).

4. **Insights surface polish + DE rename (W2 A3+A4+A5+A6).**
   Four interleaved surface fixes that move the page from
   "feature-rich and slightly cluttered" to "deliberate". A3
   retired the on-surface `<CompareToggle />` from `/insights`
   (canonical picker has lived in Settings → Dashboard since
   v1.4.16 B8; the duplicate violated
   `feedback_settings_no_split.md`). A4 fixed three half-row
   layouts that left empty space, equalised trends-row card
   heights, and stopped painting placeholders for insufficient
   correlations. A5 renamed "Muster" → "Zusammenhänge" /
   "Patterns" → "Relationships" (W1b research recommended
   either "Trends" or "Zusammenhänge"; picked the latter
   because the row directly above already uses "Trends"), and
   lifted the section tabs above the hero. A6 stripped the
   production `metric:WEIGHT` / `metric:BLOOD_PRESSURE_SYS`
   token-leak in recommendation prose (W1a §3 traced it to a
   single missing `stripChartTokens()` call) and fixed four DE
   Health-Score component labels that read English in the
   German bundle (`Mood` → `Stimmung`, `BD` → `Blutdruck`,
   `Medis` → `Einnahmetreue`, plus `Gewicht`). Reports:
   `phase-W2-report.md`, `phase-W1a-report.md`.

5. **AuthShell post-hydration redirect → proxy.ts (W4 C4).**
   4th-attempt fix at the dashboard-flash on incomplete-
   onboarding. The redirect moved out of `<AuthShell>`
   `useEffect` into `src/proxy.ts`. The proxy runs in the Edge
   runtime and can't reach Prisma, so auth routes mirror the
   DB `onboardingCompletedAt` column into a non-httpOnly
   `hl_onboarding` cookie. The proxy reads it without a DB
   roundtrip; tampering only skips the dashboard flash and
   never bypasses a server check.
   `/api/onboarding/complete` and session-destroy clear the
   cookie. The e2e onboarding-flicker spec returned to testing
   the actual incomplete-onboarding case. Files: `src/proxy.ts`,
   `src/app/api/auth/*`,
   `tests/integration/proxy-onboarding-redirect.test.ts` (new).

6. **Backlog sweep (W4 D, 12 items).** Ten quick-wins from
   `v1421-backlog.md` plus two mediums. Notables:
   `LOKI_ENDPOINT` env-var leakage in user-facing copy;
   admin/users column header `"Users"` → `"Name"`; six DE
   error-toast keys retoned from imperative to softer phrasing;
   `formatTokenName` regex broadened to non-Z ISO offsets;
   moodLog "Copy webhook secret" using `common.copy`. FX
   hygiene carry-overs: 191 source-comment `Marc` references
   swept, v1.4.14+v1.4.15 bilingual CHANGELOG entries
   normalised to English-only (per
   `feedback_marc_voice_english.md`), `CLAUDE.md` →
   `CONTRIBUTING-AI.md` rename. Report: `phase-W4-report.md`.

---

## C. v1.5 implementation plan — iOS native client + Apple Health

The handoff at `~/Projects/healthlog-iOS/` is the iOS app. v1.5's
headline is **iOS native client + Apple Health integration**.
The web app gets the API surface it already shipped in v1.4
(bearer + refresh tokens, idempotency-key — see
`~/Projects/healthlog-iOS/HealthLogIOS/docs/server-changes.md`).
Apple Health adds new measurement sources (HRV, Sleep, Resting
HR, Steps, BodyFat, Glucose). The Coach extends to ingest them.
The iOS handoff already lays out 9 phases (P0 done, P1–P9 staged
by surface).

My v1.5 plan from the server side: six phases, each ≤7 days,
sequential where they must be and parallelisable where they
don't.

### Phase P1 — iOS app first launch (~5-7 days)

Smallest deliverable that proves bearer + refresh-token end-to-
end: one login page, one dashboard widget. Email/password login
via `POST /api/auth/login` with `X-Client-Type: native` (issues
`hlk_<64hex>` access token + `hlr_<64hex>` refresh token per
CLAUDE.md). Keychain stores both. Dashboard pulls
`/api/auth/me` + `/api/analytics` and paints the latest weight +
BD-in-target % in a Lock Screen Widget. Passkey login is punted
to P3.

**Server-side files.** `src/lib/auth/issue-token.ts` (already
exists). New `src/lib/auth/refresh-rotate.ts` + `POST
/api/auth/refresh` that takes `hlr_*` and returns a fresh pair,
revoking every refresh token on reuse-detection.
`docs/api/openapi.yaml` documents the refresh route for iOS DTO
codegen.

**iOS-side files.** `HealthLog/App/Auth/LoginView.swift`,
`HealthLog/Services/APIClient.swift` (Bearer + 401 → refresh
chain), `HealthLogWidgets/LatestWeightWidget.swift`.

**Risks.** (1) Refresh-token reuse-detection is a foot-gun for
two-device users. Document as "one active device per account"
and add `GET /api/auth/me/devices` for the Settings tab to show

- revoke. (2) Cert-pinning. The iOS production scheme has empty
  pin-hashes per the iOS ROADMAP Phase 1; wire before first
  TestFlight — a missed pin update on Cloudflare cert rotation
  bricks every device.

### Phase P2 — Apple Health sync + measurement-source taxonomy (~6-7 days)

Biggest contract decision of v1.5. The iOS app reads HRV / Sleep
/ Resting HR / Steps / BodyFat / Glucose from `HKHealthStore` and
posts them to the server. Server work: (a) extend
`MeasurementType` enum; (b) introduce a `source` field on
`Measurement` distinguishing `apple-health` / `withings` /
`manual` / `mood-log`; (c) batched ingest endpoint taking
~hundreds of points per HealthKit anchor delta; (d) deduplicate
on `(source, externalId)` not `(timestamp, type)` so the same
physical reading flowing through the Withings → Apple Health
bridge doesn't get blocked.

iOS-side: `HKObserverQuery` for live updates +
`HKAnchoredObjectQuery` for incremental sync, anchor in
Keychain.

**Files.** New `prisma/migrations/0036_apple_health_
measurements/migration.sql`. New `src/app/api/measurements/
batch/route.ts` (POST, hard cap 500/req, idempotency-key envelope
per batch). New `src/lib/measurements/source-dedup.ts`.
`docs/api/openapi.yaml` regenerated.

**Risks.** (1) `MeasurementType` enum expansion — additive only,
never rename. (2) Withings → Apple Health bridge collision: the
dedup key is `(source, externalId)`. (3) Doctor-report PDF
should surface measurement source — a reading from Apple Health
that came from a third-party scale should say so.

### Phase P3 — Coach + Daily Briefing extended for new metrics (~5 days)

Today's Coach knows BP, weight, pulse, mood, compliance. v1.5
adds HRV, Sleep, Resting HR, Steps. Three places to extend:
(1) `extractFeatures()` + `src/lib/ai/coach/snapshot.ts` so the
provenance envelope label-tags the new metric keys; (2) prompt
rules in `src/lib/coach/prompts/coach-prompt.ts` so the model
knows units, windows, and conservative phrasing; (3) source-chip
i18n bundles (`insights.coach.metric.{hrv,sleep,restingHr,
steps}` in EN+DE).

The Health Score formula stays four-weighted for v1.5 — adding a
fifth component would force a band recalibration that isn't
worth the user-side surprise. v1.6 territory.

**PROMPT_VERSION ratchet 4.22.0 → 5.0.0** — major-digit bump.
New ground rules: (a) no clinical sleep-stage conclusions, no
causal language about HRV "telling" the user anything; (b)
sleep-duration-not-sleep-stages framing; (c) steps-as-context-
not-prescription. Each lands as a numbered bullet so the
schema-test regex on the prompt header catches every bump.

**Risks.** Sleep classifier disagreement (Apple vs Withings ~25%
divergence on REM/Deep/Core). Add a prompt unit-test that
asserts the model never claims a clinical sleep-stage
conclusion. HRV similarly — talk about trends in the user's own
baseline, never against a population norm.

### Phase P4 — Per-metric APNs alerts (~4-5 days)

iOS users should get APNs direct rather than the web-push
fallback. `POST /api/devices` exists in scaffold (v1.4
native-client work added the cross-user-hijack guard with 409 +
`device.register.denied` audit trail per CLAUDE.md); APNs
sender-side wiring is v1.5 work.

**Files.** New `src/lib/notifications/senders/apns.ts` (p8-key
auth, JWT signing every 50 minutes, JWT pool reuse), APNs config
row in `Settings` admin section, env block `APNS_KEY_ID` /
`APNS_TEAM_ID` / `APNS_KEY` (the .p8 contents). Per-event
opt-out reuses existing notification-rules.

**Risks.** APNs sandbox vs production pivots on a per-payload
`apns-push-type` header. Test with TestFlight against
production APNs gateway. Rate-limit at the sender (~20 req/sec
per connection without throttling).

### Phase P5 — Web app polish + v1.5 release brief (~4 days)

Two visible web-app changes once iOS is shipping:

1. **The hero's "Apple Health: coming with iOS app" placeholder
   fills.** Web users with a sync'd iOS device see HRV in the
   third hero slot; users without one see "Connect Apple
   Health" linking to the App Store listing.
2. **Vitals tile row lands.** B1's deferred layout has waited on
   real HRV / Sleep / Resting HR / Steps since v1.4.20. P5 is
   when it replaces the status-card list — the B1 structural
   blocker dissolves once the metrics are non-stub.

The Insights page split (the ~9-surface orchestrator) also lands
here, not in v1.4.23. Splitting during P5 means the split maps
to the exact sub-trees Apple Health touched, not a guess.

**Files.** `src/app/insights/page.tsx` (split into `page.tsx` +
`_components/{hero,briefing-row,score-row,correlations-row,
trends-row,coach-cta}.tsx`), `src/components/insights/hero-
strip.tsx`, new `src/components/insights/vitals-row.tsx`.
Release brief in Marc's voice (English, no "Claude / agent /
phase X" leaks per `feedback_marc_voice_english.md`). New
`docs/audit/v15-summary.md`.

### Phase P6 — Cross-user feedback aggregation cron (~3-4 days, parallelisable)

The v1.4.16 B5e infrastructure that's been waiting for the
Coach to have volume. Every release I've pushed it off because
the volume wasn't there. v1.4.22's prose rewrite is what makes
it land cleanly: the warmth + sentinel pattern produces
conversations users finish, which produces the helpful/
unhelpful signal the aggregator needs. `src/lib/jobs/feedback-
aggregator.ts` already exists; v1.5 wires it to a daily
pg-boss cron that reads the `(severity × confidence_band)`
buckets and appends OMIT / REPHRASE rules to the next
PROMPT_VERSION when a bucket's helpful-rate drops below 50%.

**Files.** `src/lib/jobs/feedback-aggregator-cron.ts` (daily
04:00 Europe/Berlin), `src/lib/coach/prompts/prompt-version-
manager.ts`. PROMPT_VERSION channel: 5.0.x → 5.0.x+1 on each
rule append.

**Parallelisable** with P1–P5 — no shared file paths.

---

## D. Strategic items NOT in the iOS handoff but relevant to v1.5

Six items that aren't on the iOS roadmap but should ride
alongside:

1. **Schema drift cleanup on `medication_schedules.days_of_week`
   (Sr-MED-5).** v1.4.20 worked around it twice; v1.4.22 didn't
   touch it. v1.5 P0 should land the missing migration OR drop
   the column from `schema.prisma`. The work-around `select`
   clauses become tech-debt as more queries touch the table.

2. **Pearson p-value normal-approx replacement (Code-MED-03).**
   At df=12 the normal approx puts true p≈0.04 at p≈0.025 — a
   generous direction we don't want when v1.5/v1.6 ships auto-
   correlation discovery. Either pull in a 30-LOC incomplete-
   beta or raise the surfacing gate to df ≥ 20. v1.5 P0 work,
   not P5 — the false-positive cost compounds when correlations
   get auto-generated.

3. **`<CoachDrawer key={prefill}>` proper state management
   (Sr-HIGH-4).** The drawer should make `prefill` a fully-
   controlled prop and drop the `key=` re-mount that
   weaponises React keys for state reset. Heavy refactor; not a
   one-line fix. v1.4.23 if there's room before v1.5 starts;
   v1.5 P3 latest. The iOS Coach surface will multiply this
   pattern's footprint and we want it clean before that lands.

4. **Conversation persistence eviction policy.** Coach storage
   shipped in v1.4.20; v1.4.22 grew the prose without changing
   the persistence shape. Auto-archive conversations after 90
   days (move `messages` to a cold table, keep the
   `conversation` row as a stub for the rail); hard-delete
   after 365 days. ~500 KB/user/month at 20 turns × 50
   conversations is tolerable today but needs the policy
   before the iOS app multiplies volume 3-5×.

5. **OpenAPI spec drift CI guard.** The iOS app reads
   `docs/api/openapi.yaml` from the server repo (per
   `~/Projects/healthlog-iOS/HealthLogIOS/docs/api-contract.md`);
   a server-side route signature change that doesn't update the
   spec will only get caught at iOS-side DTO codegen time. CI
   check on the server repo that diffs the routes against the
   spec on every PR. Pull this forward to v1.4.23 if possible —
   it's cheaper than discovering drift via an iOS build break.

6. **Settings/Integrations: `<IntegrationCard>` shell
   extraction.** Withings and moodLog card chrome are duplicated
   verbatim. v1.5's Apple Health card will copy-paste the same
   shape a third time. Extract `<IntegrationCard>` alongside the
   existing `<IntegrationStatusPill>` before the third copy
   lands. v15-backlog `D-SR-H-3` already tracks it; v1.5 P5.

---

## E. Risks / Tech-Debt watchlist

1. **Coach token-budget cap is a soft wall.** 25 000 tokens/
   user/day at ~1 800 tokens/turn = ~13 turns. Heavy iOS users
   on long road trips ("I want to think out loud about my
   health for 30 minutes") will hit the cap. The HTTP 429 is
   correct but the UX needs a clear "you've reached today's
   Coach limit; resets at 00:00 UTC" message rather than a
   generic error toast. v1.5 P3's iOS Coach surface makes this
   more visible than the web-only surface today.

2. **The "summarise older half" pass is still a placeholder.**
   The B2a history-window builder injects a synthetic
   `[summary placeholder — N earlier turns elided]` line rather
   than calling a provider to produce a real summary. Cheap and
   deterministic; an opt-in real-summarisation pass can land
   alongside v1.5 once the drawer UI shows whether users push
   past 20 turns. The W3 sentinel pattern actually gives us a
   cheap real-summary now: feed the older half's prose +
   sentinel rows to a small-model summary call. v1.5 P3 if
   usage data shows it matters.

3. **OpenAPI spec drift between server and iOS DTOs.** Same
   item as D.5 above. Calling out twice because it's the
   single most likely place v1.5 development bogs down.

4. **Refresh-token reuse-detection is a foot-gun for two-
   device users.** The reuse-detection (revokes every refresh
   token for the user when the same token is replayed —
   CLAUDE.md headless-client section) is correct for security
   but punishes any user with two iOS devices on the same
   account. Document in onboarding ("only one active device
   per account"); add `/api/auth/me/devices` for the iOS
   Settings tab. v1.5 P1.

5. **`safeParse()` legacy-payload pattern carries forward.**
   The v1.4.22 wave added one new `safeParse()` site (the
   sentinel keyValues block, falls back to no-disclosure on
   parse failure). The v1.5 PROMPT_VERSION 5.0.0 bump will
   add at least four more (HRV envelope, Sleep envelope,
   Resting-HR envelope, Steps envelope). Audit every new
   `safeParse()` call before tag — same lesson as v1.4.17
   hotfix.

6. **The Coach prose rewrite (W3) hasn't seen production
   feedback yet.** v1.4.22 ships the persona + sentinel
   together; both will go live to the live tenant on tag.
   Watch the helpful/unhelpful ratio in the first week. The
   risk: the persona pivots too far towards warmth and the
   evidence block becomes the only place the user finds an
   actionable answer. If the disclosure-open rate is below
   ~30% in the first week, the persona might need a tone
   pull-back in v1.4.23 before the iOS surface multiplies the
   audience. The aggregator cron in P6 is the right vehicle
   for this measurement once it's wired.

7. **Insights page split gets tied to v1.5 P5, not v1.4.23.**
   Deliberate. The senior-dev review for v1.4.20 will likely
   re-flag it; the review for v1.4.22 won't make a difference
   because the page didn't grow. Splitting before knowing
   which sub-trees v1.5 Apple Health work edits risks re-
   splitting twice. Holding the line.

---

## F. Candid one-liner

v1.4.22 is the second-beat polish that v1.4.20's loud release
needed to feel finished — Coach prose finally talks like a
partner, the BD tile finally feels like a live metric, and the
backlog tail is short enough that v1.5 starts on real product
work instead of debt repayment.
