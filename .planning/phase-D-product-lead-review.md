# v1.4.16 — Product-Lead Review

Author: Marc (strategic memo to self)
Date: 2026-05-10
Status: pre-release of v1.4.16; v1.4.15 live since the night before.

This is the strategic lens. The other reviewers (code, security, design,
senior-dev, simplify) are landing CRITICAL/HIGH inline. I am writing
this for the question Marc-three-weeks-from-now will ask: *what state is
the app in, and what does v1.5 actually need to look like?*

---

## A. State of the App

**Auth + data model: STRONG.** Passkeys (SimpleWebAuthn v13) plus
HMAC-keyed bearer tokens for native clients (`hashToken()`,
`API_TOKEN_HMAC_KEY`), idempotency-replay protection on every mutation
(`withIdempotency()`, with the `hlk_/hlr_` echo defence), AES-256-GCM
on every sensitive column, versioned encryption keys with rotation
script (`scripts/rotate-encryption-key.ts`), GDPR-cascade delete
covered by integration tests, refresh-token reuse-detection that
revokes the entire family. 26 Prisma models. Multi-tenant prep
(`HEALTHLOG_PROCESS_TYPE=web|worker|all`) is wired. This bar is rare
in a personal-tracking PWA.

**Tracking surfaces: SOLID, just got a real visual upgrade.** BP /
weight / pulse / mood / medication all log, list, chart, and trend.
B1a (`74c2eb8`, `901f44e`, `8008613`) finally moved every chart from
flat Recharts lines to gradient-filled `ComposedChart` with a 90-day
median personal-baseline reference line, rich tooltips with delta-vs-
baseline, mood gets emoji glyphs at every score. B8 (`2cf7b74`,
`e4a408e`, `f9f99ea`) layers comparison-vs-last-month / vs-last-year
overlay across charts, dashboard tiles, and the AI summary. B1b
(`4d7d074` ff.) gave `/insights` an Oura-style hero with severity-
ordered grid + animated reveal. The charts no longer feel like a v0.
The data model behind them is honest: `bucketSeries()` already
returns 360 daily + 24 monthly buckets, so we can reach 3y comparisons
with no new pipeline.

**AI Insights: from demo to early differentiator.** v1.4.13 was Codex
limping. v1.4.15 C1 hardened it (strict zod schema, `metricSource`
mandatory, citation cross-check, retry-once-with-corrective-prompt
or 422). v1.4.16 doubled down: B5a curated medical-reference bundle
(AHA / ESH / WHO / DGE) with citation footnotes; B5b multi-provider
fallback chain with last-working-cache; B5c per-rec rationale (window /
comparedTo / deviation) with mini-chart of the cited window; B5d
deterministic server-computed confidence score (model's own number is
discarded — `confidence.ts`); B5e `RecommendationFeedback` table +
thumbs UI + daily aggregator + `/admin/ai-quality`. PROMPT_VERSION
4.16.1. This is the first version where I would show insights to a
GP without flinching.

**Admin tooling: maturing fast.** v1.4.14 split admin into per-route
sections; v1.4.15 added backup download / upload / triple-confirm
restore; v1.4.16 added the host-load chart (B3, in-process sampler),
filterable + paginated + CSV-exportable audit log (B4), 500-entry
in-memory app-log preview with JSON inspector, AI quality dashboard
(B5e), and `/admin/ai-quality`. Admin is now a real ops surface, not a
settings page in disguise.

**Mobile UX: post A5 + B-mobile + B1a, finally honest.** 44px tap
targets (Wave-C H4 design), card-list fallback at <md for both users
and api-tokens tables, bottom-nav 5+More with overflow sheet
(`072eee6`), tabs horizontal scroll on mobile (`d7c2b2a`), system-
status retry, chart vertical-scroll passthrough. The mobile-first
hard-rule actually holds today.

**Auto-deployment + CI: half-fixed.** v1.4.15 wired GHCR-publish →
Coolify-webhook → audit-log + Telegram alert. But Coolify's GitHub-App
auto-deploy still fires on every git-push including doc-only commits
(`docs/audit/v1416-auto-deploy-fix.md`), because the MCP API does not
expose the toggle. **This is the most-visible piece of unfinished v1.4
work.** Wave-C also dropped arm64 from the docker-publish matrix
because qemu-arm64 SIGILLs — v1.5 needs a native ARM runner.

**Backup/restore + Doctor-Report + Achievements + Onboarding tour:
feature-complete.** Backups round-trip, Doctor-Report v2 has
configurable date range + practice name on cover, achievements have
their own page + dashboard card, onboarding tour with focus trap +
prefers-reduced-motion. `BACKUP_S3_*` env block is present in
`prisma.config.ts` adjacent code but **the off-host push is not
wired.** That is a v1.5 item.

---

## B. Biggest items across v1.4.14 + v1.4.15 + v1.4.16

The 8 things that moved the needle:

1. **Codex/ChatGPT-account auth finally works** (v1.4.14 `5df74f7`,
   then v1.4.16 follow-ups `cfa8ea6`, `e4a07bc`, `e0de659`,
   `68e5797`). No API plan needed. This was the v1.4.7-13 saga; it's
   over. Enables: every AI feature below.

2. **Admin panel split into real sections** (v1.4.14 `12b280b`,
   `73965cd`). From single mega-page to per-section dynamic routes.
   Why it matters: every later admin feature (backups UI, users, host-
   load, audit-log filter, app-logs, ai-quality) plugged into this
   shell without touching neighbours. Enables: B3 + B4 + B5e admin
   surface with no shell rewrites.

3. **Backup full lifecycle** (v1.4.15 `fe85c2c`, `d8c549e`,
   `30a74ed`). Triple-confirm restore + download + upload + audit log
   on every operation. Why it matters: this is the difference between
   "I have your data backed up" and "you can recover from a mistake".
   Enables: real GDPR Art. 17 story, S3-push v1.5 follow-on.

4. **AI strict schema + citation cross-check** (v1.4.15 `d657f79`,
   `4e85c38`, `4bba951`). Strict zod, metricSource mandatory,
   uncited-rec rejection, retry-once. Why it matters: zero
   hallucinations after v1.4.15; v1.4.16 layered explainability on
   top instead of fighting hallucinations. Enables: B5a/c/d/e.

5. **AI explainability stack** (v1.4.16 B5a-e). Medical-reference
   citations, multi-provider fallback chain, per-rec rationale + mini-
   chart, deterministic confidence score, feedback loop with admin
   aggregate. Why it matters: this is the line between "demo-ware
   chatbot" and "you can show this to a doctor". Enables: prompt-
   ratchet v1.4.17, per-prompt-version A/B v1.5+.

6. **Charts visual leap (B1a + B1b + B8)**. Gradient + animated +
   personal baseline + comparison overlays + Oura-style insights
   surface. Why it matters: until v1.4.15 the charts were the weakest
   visual surface; today they are the strongest after the dashboard
   itself. Enables: any "yearly summary email" or "wrap-up" feature
   off the same primitives.

7. **Onboarding tour + achievements + empty states**
   (v1.4.15 `e57fc0a`, `34c967c`, `9a74f8e` ff.). New accounts now
   land somewhere meaningful instead of an empty dashboard. Why it
   matters: this is the difference between "for me" and "for users."
   Enables: opening a public beta if I ever want to.

8. **Native API contracts stabilised** (v1.4.15 multi-provider,
   v1.4.16 `RecommendationFeedback` API + idempotency-everywhere).
   `X-Client-Type: native` opt-in returns `hlk_` token, refresh
   rotation with reuse-detection, all mutations idempotent. Why it
   matters: the iOS app (`~/Projects/healthlog-iOS`) can now hit
   stable endpoints without me back-porting fixes. Enables: native
   client work this summer.

---

## C. v1.5 Roadmap

This is where the strategic decisions live. v1.4.x has been
incremental hardening; v1.5 is the next minor and should ship the
things that *change what the product is*.

### C.1 Coolify image-digest auto-deploy

**What.** Flip Coolify Auto-Deploy off (manual UI toggle, MCP API
doesn't expose it on v4-beta), make the GHCR-publish webhook the sole
deploy trigger. Per `docs/audit/v1416-auto-deploy-fix.md`.
**Why now.** Every doc-only commit currently recreates containers.
This is daily user-visible churn.
**Effort.** S (5min Marc-side toggle + 1 verification commit).
**Importance.** Tech debt → user-visible reliability win.
**Dependencies.** None — design is locked.

### C.2 Native ARM runner matrix for docker-publish

**What.** Re-add linux/arm64 to the GHCR matrix using a native
`ubuntu-24.04-arm` runner (qemu-arm64 SIGILL is the reason Wave-C
dropped arm64).
**Why now.** Apple Silicon dev machines and ARM-based Coolify nodes
should pull native; v1.4.16 left them on amd64-emulation.
**Effort.** S (workflow YAML).
**Importance.** Tech debt + iOS-adjacent dev experience.
**Dependencies.** GH-side runner availability.

### C.3 Cross-user feedback aggregation prompt-tuning ratchet

**What.** B5e shipped the `RecommendationFeedback` table + daily
aggregator → `AppSettings.adminAiInsightsFeedbackSummary`. The next
step — append per-(severity × confidence_band) "OMIT" or "REPHRASE"
rules to `PROMPT_VERSION` automatically when a bucket's helpful-rate
drops below threshold — was deferred. Also: store
`recommendationConfidence Int?` on the feedback row (research §5.2,
flagged in B5e report) so the ratchet can slice by confidence band.
**Why now.** Otherwise the feedback loop is a write-only
collection — Marc-the-user has no path from "this rec was useless" to
"the model stops emitting recs of that shape."
**Effort.** M (schema column + ratchet job + per-version PROMPT
freeze + admin manual-bump UI).
**Importance.** Differentiator. Self-improving AI is the moat.
**Dependencies.** B5e (shipped), B5d confidence (shipped).

### C.4 Dedicated `/insights/compare` page

**What.** Side-by-side current-vs-prior with sticky baseline picker.
B8 shipped overlays on existing charts + tile callouts + AI
narration; the dedicated comparison page was deferred (B8 report).
Add the `aiInsightResponseSchema.comparison` field +
`<InsightsComparisonCallout>` component above the recommendations
grid. i18n keys `comparison.insightsCallout.{lastMonth,lastYear}`
already reserved.
**Why now.** The narration-only comparison is buried inside summary
text; users need a top-of-page hero callout to anchor the comparison
view.
**Effort.** S–M (page route + schema flip + callout component).
**Importance.** User-facing differentiator.
**Dependencies.** B8 (shipped).

### C.5 AI: streaming responses + prompt-version A/B + per-user
fine-tune-equivalent

**What.** Three sub-items, sized for v1.5:
- **Streaming.** SSE/`ReadableStream` from `/api/insights/generate`
  so the user sees the summary text appear progressively. Codex
  already streams via SSE on the wire — we currently buffer. Effort
  S–M.
- **Prompt-version A/B.** Today PROMPT_VERSION is a single constant.
  v1.5 should let `/admin/ai-quality` flip a 50/50 split between
  v4.16.x and v4.17.x for two weeks, then read the helpful-rate
  delta from the existing aggregator. Effort M.
- **"Per-user fine-tune."** Not literal model finetune — a per-user
  prompt prefix derived from the user's accepted feedback (e.g.
  "this user dismisses sleep-related recs; emphasise BP and weight
  trends instead"). Effort M.
**Why now.** B5e already collects the signal; B5b already
attributes by provider; the loop is a half-circle without these.
**Importance.** Differentiator (combined: this is what no
consumer-grade health app does).
**Dependencies.** C.3.

### C.6 Charts library decision

**What.** Recharts will hit a ceiling for the comparison-overlay
quality bar (B8 shipped a `ComposedChart` with two `<Line>` paths and
a custom dimmed-stroke prop, but the second-axis tooltip + per-segment
opacity is already painful). Decide v1.5: stay on Recharts and keep
patching, or swap to a library with first-class gradient + animation
+ multi-series (Visx, Tremor, Apache ECharts via React-EChartsCore).
**Why now.** Every future chart feature (yearly summary, Apple Health
import overlay, longitudinal correlation lines) hits the same
ceiling. Decide before adding the next 3 charts.
**Effort.** L (full chart wrapper rewrite, ~12 chart files).
**Importance.** Enabler. The decision either unlocks or constrains
every visual roadmap item below.
**Dependencies.** B1a/B1b primitives (`chart-gradient`, `chart-
tooltip`, `chart-empty-state`, `health-chart`) define the contract a
new library has to satisfy. The prop surface is small.

### C.7 iOS native client API contract freeze

**What.** Lock the v1 contract for the separate
`~/Projects/healthlog-iOS` repo. Specifically:
- `POST /api/auth/login` + passkey-login-verify (existing).
- Token rotation contract (existing — but document the 24h access /
  90d refresh defaults so iOS doesn't surprise-fail at 24h+ε).
- Idempotency-Key contract (existing — but iOS retry behaviour needs
  the regex doc'd).
- `POST /api/devices` cross-user-hijack-409 (existing).
- Bearer-only routes for measurements, mood, medications,
  achievements, insights, doctor-report.
- **Missing:** `POST /api/measurements/bulk` for offline-queue replay
  on reconnect. iOS will need it; today it would loop unary calls.
- **Missing:** Versioned API path (`/api/v1/`) so v1.5 can break v2
  without breaking the shipped iOS app.
**Why now.** Native client work has to happen against a stable
contract. Today everything is unversioned.
**Effort.** M (versioned router + bulk endpoint + contract doc).
**Importance.** Enabler for the iOS investment.
**Dependencies.** None blocking; clean to do.

### C.8 Security hardening sweep

- **Passkey replay-attack defences.** Today the `webauthn_challenge`
  cookie is single-use (good) but counter is not enforced for cross-
  authenticator scenarios. Audit + harden. Effort S.
- **Idempotency-Key TTL.** Currently 24h hardcoded. Make it env-
  configurable + add admin-side audit on replay-rate. Effort S.
- **Audit-log retention policy.** Today everything keeps forever;
  with v1.4.16 host-metric sampler at 1-row-per-minute we'll hit
  storage growth in months, not years. Add a configurable retention
  with a worker job that archives older rows to S3. Effort M.
**Why now.** Audit-log + host-metric tables are growing 24×60 rows
per day each. Compute the year-out size; act before it bites.
**Importance.** Tech debt.
**Dependencies.** None.

### C.9 Performance — Recharts deferred bundle, SSR insights,
read-replica

- **Recharts deferred bundle:** v1.4.14 saved 108 KiB on `/insights`.
  Same trick on `/`, `/measurements`, `/mood`. Effort S each.
- **SSR insights:** today `/insights` is a client-side fetch after
  paint. Server-render the cached payload (we already have it server-
  side via `User.insightsCachedText`). Cuts time-to-content by
  ~600ms on cold loads. Effort M.
- **Prisma read-replica.** Adapter API supports it. The bottleneck
  isn't writes; it's the bucket-series read on `/insights` and
  dashboard. Effort M.
**Why now.** v1.4.16 added the host-load chart to admin which makes
real perf data visible; if I don't act on it, why did I add it.
**Importance.** Tech debt + UX.
**Dependencies.** C.6 charts decision (if Recharts goes, so does the
deferred-bundle work).

### C.10 Cross-device backup encryption + S3 push

**What.** `BACKUP_S3_*` env block is documented in CLAUDE.md (PutObject
+ GetObject, retention via bucket lifecycle) but the actual S3-push
worker is **not wired**. Wire it; encrypt with the same versioned
encryption-keys mechanism (different DEK per backup, KEK rotation via
the existing `rotate-encryption-key.ts` script). Add download-from-
S3 + restore-from-S3 to `/admin/backups`.
**Why now.** Today a host disk failure loses the last week of
backups. Sunday-snapshot is local-only.
**Effort.** M.
**Importance.** Differentiator (true off-host backup, encrypted, with
a published restore path) + GDPR-data-portability story.
**Dependencies.** None.

### C.11 Integrations — Apple Health, Garmin, Oura

This is the *strategic* roadmap item.

- **Apple Health import.** The native iOS app is the natural pipe;
  parse XML export (`export.xml` from Health.app) and POST to
  `/api/measurements/bulk` (see C.7). Effort M (just XML parse + map
  + bulk endpoint).
- **Garmin Connect.** OAuth + sync service mirroring
  `src/lib/withings/`. Effort M.
- **Oura.** OAuth + their API is JSON-clean; the metric mapping is
  already what HealthLog speaks. Effort M.

Don't try to ship all three. Apple Health first (because the iOS app
is the carrier and the XML parse is the cheapest), then **Oura**
(because Marc benchmarked against it and the score-contributors UI
B5c was inspired by it — natural completion of the loop), then
Garmin if there's still a v1.5 budget.

**Importance.** Differentiator. HealthLog with Withings-only is a
tracker; HealthLog ingesting Apple Health + Oura is *a hub*.
**Dependencies.** C.7 bulk endpoint + versioned API.

### Honest sizing

- **1-week wins:** C.1, C.2, C.4, C.8 idempotency-TTL + passkey-replay.
- **1-month items:** C.3 prompt-tuning ratchet, C.5 streaming + A/B,
  C.7 iOS contract freeze + bulk endpoint, C.9 SSR insights, C.10 S3
  backup push, C.11a Apple Health import.
- **Quarter-investment:** C.6 chart library swap (do this *first* if
  doing it at all — block other chart work behind the decision), C.5
  per-user prompt prefix (needs ~60 days of feedback collection
  first), C.11b Oura full integration.

If Marc has 6 weeks of focus for v1.5: ship C.1 + C.2 + C.4 + C.7 +
C.10 + C.11a Apple Health. That is a release that fundamentally
changes what HealthLog is *to a user*.

---

## D. Follow-on initiatives (v1.6+)

Things v1.4.16 *unlocked* but aren't natural v1.5:

1. **Compliance-export admin tool** off the v1.4.16 B4 audit-log
   filter API. Same filter shape, output is a signed PDF + CSV bundle
   with a verification hash. Doctors / employers / legal hold
   scenario.

2. **Anomaly-detection alerts** off the v1.4.16 B3 host-metrics
   sampler. Already storing 1-min CPU/mem/disk-io for 7d retention;
   feed the deviationStdRatio analytics from `confidence.ts` against
   the host series and Telegram-alert when a sustained anomaly
   crosses 1.5σ. Same alerting infra as v1.4.15 sync-fail alerts.

3. **Per-prompt-version × per-provider quality dashboard** off the
   v1.4.16 B5b provider chain + B5e feedback. Today the admin AI-
   quality table slices by (severity × provider). Add (prompt-version
   × provider) and (rationale-window × provider) — once we have 3+
   prompt versions live across 2 providers, this is the first place
   to read "is the new prompt actually better than the old one".

4. **"Explain like I'm 5" public preview.** The
   `RecommendationFeedback` table has the structure for opt-in
   anonymised cross-user voting on a public surface — present 3
   recommendations Anonymous-User-X dismissed, let visitors guess
   which one was a hallucination. Marketing surface that doubles as
   training data for the prompt ratchet. Privacy-pristine because
   the table already separates `userId` from the rec text.

5. **Yearly health-summary email digest** off v1.4.16 B8 comparison
   views. The vs-last-year overlay is the data; wrap the existing
   `<HealthChart>` SVG into an email-safe HTML render, ship via the
   existing notification dispatcher (Telegram/ntfy/web-push already
   wired; add email channel). End-of-year + birthday triggers.

6. **Rationale-driven on-device predictions.** The v1.4.16 B5c
   rationale carries `dataWindow` + `comparedTo` + `deviation` per
   rec. Run the same `confidence.ts` math client-side on the most
   recent N points and surface "today's 7-day window is trending
   toward an out-of-target reading" *without* an LLM call. Local,
   private, instant.

7. **Public-facing API for self-export.** v1.4.16's bearer-token +
   idempotency + per-handler audit row is everything a third-party
   integration needs. Document the API surface, ship a
   `/developers` page on the docs site, gate per-user via API
   tokens (already in admin).

---

## E. Risks / Tech-Debt watchlist (before v1.5)

1. **Coolify auto-deploy on git-push.** Every doc-only commit
   recreates containers. Single-most-visible churn. Fixed by 5min
   Marc-side toggle (C.1).

2. **Recharts ceiling.** B8 already needed a custom dimmed-stroke
   prop. The next chart feature (multi-axis, stacked-area-with-band,
   small-multiples grid) will be the breaking point. Decide the
   library question (C.6) *before* the next chart commit lands.

3. **In-memory app-log buffer is per-process.** v1.4.16 B4 ships a
   500-entry FIFO. With `HEALTHLOG_PROCESS_TYPE=worker` the worker's
   buffer is invisible to the web process serving `/admin/app-logs`.
   Single-process today (default `all`) so unobservable, but
   v1.5+ multi-process splits will bite. Move to a Loki query or
   PostgreSQL-table-backed ring buffer.

4. **AI provider chain has no per-provider model override UI.** B2
   shipped one Pulldown driving the active provider's model + chain
   ordering. But each chain entry only carries `providerType`, not
   `(providerType, modelOverride)`. So a user who wants "Codex with
   gpt-5.3-codex first, OpenAI with gpt-4o-mini fallback" can only
   set the active model; the fallback uses each provider's default.
   Fix needs a chain-entry shape change.

5. **`User.insightsCachedText` lacks invalidation timestamps.**
   CLAUDE.md flagged this in v1.4.x. v1.4.16 A7 partially mitigated
   (delete on regenerate) but legacy payloads predating B5c rationale
   still detect-and-CTA-regenerate manually. Add `cachedAt` +
   `cachedSchemaVersion` columns; auto-invalidate on PROMPT_VERSION
   bump.

6. **Audit-log + host-metric table growth.** ~1.5k rows/day for
   audit, ~1.4k rows/day for host-metric. Project to ~1M rows/year
   combined, no retention policy today. Add archive-to-S3 worker
   (folds neatly into C.8 + C.10).

7. **Chart wrapper architectural deviation in B1a.** The brief asked
   for separate `blood-pressure-chart.tsx` / `weight-chart.tsx` /
   `pulse-chart.tsx`; B1a kept one `HealthChart` wrapper. Right call
   for DRY today, but the three families will diverge once we add
   metric-specific affordances (BP target-range bands, weight target
   line, pulse zones). Earmark the split for the chart-library
   decision (C.6).

8. **Cross-agent commit-message drift** (process). v1.4.15 had 8
   commits with subjects belonging to a different worker; v1.4.16
   reduced this materially via worktree adoption (`agent/<phase>`
   pattern), but a few still slipped (`a66c128`, `8d9f864`,
   `226cac4`, `2611bb4`, `901f44e`). Worktree-per-agent is the rule
   now — close to zero drift in the second half of the marathon.
   Keep the rule.

---

## F. The candid one-liner

HealthLog is no longer "Marc's weekend tracker with a clever passkey
flow" — it's a personal-health-data hub with a citation-grounded AI
that I would actually show a doctor, and v1.5 is the release where it
either picks up the iOS app + Apple Health + off-host backup story
and becomes a *product*, or stays a very polished tool that only one
person uses.
