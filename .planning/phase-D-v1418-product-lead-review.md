# v1.4.18 — Product-Lead Review

Author: Marc (strategic memo to self)
Date: 2026-05-10
Status: pre-release of v1.4.18; v1.4.17 hotfix live since the morning;
v1.4.16 live since the night before that.

This is the lens that sits above the QA reviewers (code, security,
design, senior-dev, simplify). The other agents are landing
CRITICAL/HIGH inline; I am writing this for the question
_Marc-three-weeks-from-now_ will ask: **what state is the app in after
v1.4.16 → v1.4.17 → v1.4.18 in 36 hours, and what does v1.5 actually
need to be?**

The previous review at `.planning/phase-D-product-lead-review.md` (the
v1.4.16 strategic memo) is the base; this is the diff.

---

## A. State of the App — what changed since v1.4.16

The 24h since the v1.4.16 memo have been a course-correction cycle.
Three concrete shifts:

**Charts walked back from "Apple-Health polish" to clean lines + opt-in
overlays.** v1.4.16 B1a put gradient area-fills under every line, emoji
glyphs on every mood data point, and an always-on personal-baseline
ReferenceLine. Marc looked at it on his phone and rejected all three.
v1.4.18 A3 (`agent/a3-charts-revert`, six commits) deleted the
`chart-gradient` module, replaced mood emoji with plain dots, gated the
baseline behind a Trend toggle, and added a per-chart settings-cog
popover with three independent switches (Trend / Trend-arrow /
Target-range), defaults all OFF. Persistence reuses the v1.4.16 B8
`User.dashboardWidgetsJson` JSON-blob pattern (no Prisma migration).
The wins from B1a that I kept — smooth interpolation, rich tooltips,
600 ms ease-out animation — are still in. **The lesson: the v1.4.16
"chart visual leap" headline overshot reality by about three rejected
features.** Net visual quality is now higher than v1.4.15 and lower
than v1.4.16's marketing claim — the right place to be.

**Achievements expanded from a feature into an engagement surface.**
v1.4.18 B1 grew the roster 38 → 59 (+15 public, +6 hidden Easter-eggs),
added an `applyDiscoveryFilter` so locked-without-data badges hide
themselves, and crucially: **hidden achievements never render their
strings to the DOM until unlocked** — the page-source-inspection
attack on Easter-eggs is closed. New unlock toast plays an 8-second
Sparkles celebration with a localized "you unlocked a hidden
achievement!" headline. This is the first feature where I would tell
another user "go play with it" rather than "here's the data view".

**The /admin/api-tokens scrollbar took 3 release cycles to fix
correctly.** v1.4.15 hid columns. v1.4.16 added a card-list at <md.
v1.4.18 A2's Playwright probe at Pixel-5 against PROD pinned the bar
to the **AdminShell mobile section strip** (13 entries, 1692 px
scrollWidth) — one component above the api-tokens card. Every
previous attempt fixed the wrong component. New `.no-scrollbar`
utility applied to AdminShell + SettingsShell mobile strips. **Lesson:
when a defect survives two fixes, the bug isn't where the user is
pointing.**

**A regression that survived v1.4.15 + v1.4.16 finally fixed.** The
BD-Zielbereich tile rendered "7T: —" / "30T: —" because `/api/analytics`
only computed a single 30-day `bpInTargetPct` and the dashboard tile
passed `avg7={null}`/`avg30={null}` — pure unfinished wire, not a
calc bug. v1.4.18 A1 added `computeBpInTargetWindows()`, surfaced
`bpInTargetPct7d`/`bpInTargetPct30d`, threaded both through.

**v1.4.17 hotfix exposed schema-migration fragility.** v1.4.16's
strict zod schema was great for new payloads; pre-existing cached
insight blobs in the v1.4.14 shape (`{changed, stable, drivers,
nextSteps}`) fell through `safeParse()` and crashed
`<InsightAdvisorCard>` with `Cannot read properties of undefined
(reading 'replace')`. Six hours after v1.4.16 went live. Hotfix added
an `isLegacyInsightPayload()` detector, a self-contained legacy-CTA
card with a regenerate button, and defense-in-depth in
`stripChartTokens()`. Pattern to remember: **strict schema migrations
need a legacy-payload-CTA path, not a crash.**

Cumulative trajectory v1.4.14 → v1.4.18: **quality bar is moving up,
unevenly.** v1.4.14 was Codex-OAuth saga end + admin split. v1.4.15
was features (achievements / tour / backups / integrations). v1.4.16
was the polish-leap (AI explainability + chart polish). v1.4.17 +
v1.4.18 are the **course-correct cycle** — the polish-leap shipped
faster than judgement could vet it, three of its visual decisions got
rejected, one of its schema decisions crashed. The ratio of "feature
ship" to "feature walked back" is now closer to honest.

---

## B. Biggest items shipped this run (v1.4.16 + v1.4.17 + v1.4.18)

The top 6 in priority order:

1. **AI explainability stack landed** (v1.4.16 B5a–e). Citations,
   multi-provider fallback, per-rec rationale + mini-chart, deterministic
   confidence score, feedback loop with admin aggregate. This is the
   line between "demo chatbot" and "you can show this to a doctor".

2. **Chart visual identity reset** (v1.4.18 A3, commits inside
   `agent/a3-charts-revert`). Clean line is the default; Trend / Arrow /
   Target-range each opt-in, persisted per user per chart via
   `User.dashboardWidgetsJson.chartOverlayPrefs`. The persistence
   pattern is the more important deliverable than the revert itself.

3. **Achievements as an engagement surface** (v1.4.18 B1, commits
   `75c74f1...e75ea75`). 59 total, 6 hidden, opaque DOM rendering for
   undiscovered Easter-eggs, discovery-filter for relevance. First
   feature I'd recommend to another user.

4. **Comparison overlay** (v1.4.16 B8). vs-last-month / vs-last-year
   on every chart + tile + AI summary, off the same `bucketSeries()`
   pipeline. The dedicated `/insights/compare` page is still pending.

5. **`/admin/api-tokens` mobile finally clean** (v1.4.18 A2,
   `3e16074`). After two wrong fixes, a Playwright PROD probe pinned
   the actual culprit to AdminShell. Same fix benefits SettingsShell.

6. **Regression cleanup wave** — BD-tile sub-values wired (v1.4.18 A1,
   `23363ca`); legacy-insight-payload CTA instead of crash (v1.4.17,
   `79bfa27`). These are the kind of small fixes that decide whether
   I trust the app.

---

## C. Updated v1.5 roadmap

Lifting C.1–C.11 from the v1.4.16 review as the base. v1.4.17 +
v1.4.18 changed five things; everything else stands.

### What's still on the list (unchanged from v1.4.16 review)

C.1 Coolify image-digest auto-deploy — still 5min Marc-side toggle.
C.2 Native ARM runner matrix for `docker-publish` — still S effort.
C.4 Dedicated `/insights/compare` page — i18n keys still reserved.
C.5 AI streaming + prompt-version A/B + per-user prompt prefix.
C.6 Charts library decision — see update below.
C.7 iOS native API contract freeze + `/api/v1/` versioning + bulk
endpoint.
C.8 Security hardening sweep (passkey replay, idempotency-TTL,
audit-log retention).
C.9 Performance — Recharts deferred bundle / SSR insights /
read-replica.
C.10 Cross-device backup encryption + S3 push.
C.11 Integrations — Apple Health → Oura → Garmin (recommended order
unchanged).

### What's NEW for v1.5 after v1.4.17 + v1.4.18

#### C.12 — Per-user UI preference persistence as a platform pattern

**What.** v1.4.18 A3 introduced `User.dashboardWidgetsJson.chartOverlayPrefs`:
a JSON sub-blob per UI surface, stored on the existing widgets column,
hydrated client-side via `useChartOverlayPrefs`, persisted via a thin
`PUT /api/dashboard/chart-overlay-prefs` route. Migration-free. The
contract is small enough to extract.
**Apply to:** sidebar collapsed state (currently localStorage, lost on
device swap), dashboard tile order (currently fixed), per-section
default time-window (currently 30d everywhere), per-channel
notification preferences (currently all-or-nothing per category). All
five are the same shape: small typed JSON, owned per user, default-off,
opt-in surface.
**Effort.** S per surface, M for the extracted hook + route.
**Importance.** Quality-of-life multiplier. Low-risk, high-perceived-
polish.
**Dependencies.** None.

#### C.13 — Achievement engine as a "next-best-action" predicate engine

**What.** v1.4.18 B1's evaluators are pure predicates over user data
(`mood-streak-7`, `weekend-warrior`, `consistent-month`). The same
predicate engine could drive **next-best-action suggestions on the
dashboard**: "you're 1 day from `mood-streak-7` — log today's mood",
"you have 47 BP readings, 3 from `bp-100`". The dashboard becomes
self-explanatory for new users.
**Effort.** M (new `<NextActionCard>` + reuse evaluator engine).
**Importance.** Differentiator. Apple Health / Withings show stats
but don't tell you what to do next; this would.
**Dependencies.** B1 evaluators (shipped).

#### C.14 — Hidden-achievement pattern as "discover features" tutorial

**What.** v1.4.18 B1's hidden Easter-egg pattern (locked-but-visible
opaque card, real strings hidden from DOM, unlock celebration) is a
generic "guided discovery" surface. Apply to **product features**: an
opaque "Connect a wearable" card unlocks Withings + moodLog + (v1.5)
Apple Health setup; "Set up automation" unlocks notification rules;
"Export for your doctor" unlocks the doctor-report. New users see
locked tiles, get a hint per category, and discover the surface area.
**Effort.** M (extract the opaque-card primitive + author 8–10 feature
"achievements").
**Importance.** Differentiator + replaces the v1.4.15 onboarding tour
with something stickier (one-shot tour vs. always-visible card grid).
**Dependencies.** B1 hidden pattern (shipped).

#### C.15 — Engagement loop on top of the achievement surface

**What.** Three layered features off B1:

- **Streak repair tokens.** A user breaks a 30-day streak by traveling.
  Award one repair token per quarter that retroactively closes a single
  gap. Soft loyalty.
- **Monthly digest emails.** End-of-month: "you unlocked 3 achievements,
  hit `consistent-month`, your BP improved 4 mmHg vs. last month".
  Reuses v1.4.16 B8 comparison + `RecommendationFeedback` aggregator
  shape. Notification-channel "email" is the only new piece.
- **Friend-only leaderboards.** Opt-in, no global ranking, no
  comparison without explicit consent. Two friends who both opt-in see
  each other's streak counts and unlock-rate. No public leaderboard,
  ever.
  **Effort.** S/M/M.
  **Importance.** Differentiator (combined). The market has tracker apps
  and "social fitness" apps; nothing in between done with privacy as a
  hard rule.
  **Dependencies.** B1 (shipped); email channel needs adding to
  `src/lib/notifications/dispatcher.ts` (~1 day).

#### C.16 — Admin/Settings shell layout audit

**What.** A2 took three release cycles to fix because each fix targeted
the wrong layer (api-tokens table → mobile card-list → finally
AdminShell strip). The broader admin/settings shell layout has issues
the per-component fixes won't catch. Run a focused audit pass across
**all 13 admin sections + 10 settings sections** at three viewports
(Pixel-5, iPad portrait, desktop) with Playwright + scrollWidth
diffing. Catalog every overflow. Fix the shell, not the leaves.
**Effort.** S–M (probe + fix wave).
**Importance.** Quality. The shell is the picture frame; today the
frame is bent in places.
**Dependencies.** None.

### What's REMOVED from v1.5 candidate list

Nothing. v1.4.16's deferred items (Coolify image-digest, native ARM
runner, prompt-tuning ratchet, `/insights/compare` page) all still
pending, all still good v1.5 candidates.

### Updated 6-week focus pick

v1.4.16's pick: **C.1 + C.2 + C.4 + C.7 + C.10 + C.11a Apple Health**.

After v1.4.18, I'd add **C.12 (preference persistence pattern)** as a
running side-quest — the wins are too cheap to skip and they build the
muscle for C.7's iOS contract. Drop nothing from the original pick.
Total effort still ~6 weeks because C.12 is parallelisable with C.7
(both are JSON-blob persistence shape decisions).

---

## D. Follow-on initiatives that build on v1.4.18 specifically

Three candidates rooted in v1.4.18 that I want on the v1.6+ shortlist:

1. **Hidden-achievement pattern → "discover features" tutorial surface
   (C.14 above, also belongs here).** The opaque-card + unlock-on-trigger
   primitive is the right shape for product discovery. Today new users
   meet a tour-then-empty-dashboard experience; an "unlocked surface
   area" pattern keeps surface area visible without overwhelming.
   _Why this is a follow-on, not a v1.5 must-have:_ it works only when
   the surface area is large enough to warrant discovery, which Apple
   Health + Garmin + Oura integrations (C.11) provide. Land C.11 first,
   then layer C.14.

2. **Per-chart toggle prefs as a template for ALL UI personalization
   (overlap with C.12).** The settings-cog popover on every chart in
   A3 is the right interaction model for any "I want this surface my
   way" affordance — sidebar-collapsed, dashboard-tile-order, dashboard-
   tile-time-window, notification-channel-per-event. The per-chart
   pattern is the prototype; v1.6 generalises it to a `<UISettings>`
   primitive that any client component can drop in. **What this unlocks:**
   user-configurable everything without a dedicated `/settings`
   page.

3. **Achievement evaluators as a reusable predicate engine for
   next-best-action suggestions (C.13 above).** The evaluators are
   already pure functions over `(user, data) → boolean | progress`.
   Adapt to "what are the 3 closest unlocks for this user" — surface as
   dashboard nudges. **What this unlocks:** the dashboard becomes
   self-narrating ("you're 1 BP reading away from `bp-50`") without
   needing the AI insights pipeline at all. Local, instant, no LLM
   call. Pairs cleanly with the v1.6 candidate "rationale-driven
   on-device predictions" from the v1.4.16 review §D.6.

---

## E. Risks / Tech-Debt watchlist

1. **v1.4.18 reverted v1.4.16's chart polish — what's the accumulating
   risk?** Three visual decisions (gradients, emoji, auto-mean) shipped,
   were rejected, were reverted. The deeper risk: in v1.5, somebody
   (me, or a design-review agent) is going to propose those exact
   things again under different framing — "subtle area fill",
   "expressive mood scale", "smart baseline". The `feedback_charts_visual_identity.md`
   memory is the guardrail; **add a CLAUDE.md rule** in v1.5 that
   chart visual changes need explicit Marc sign-off, not just
   design-review approval.

2. **`.no-scrollbar` utility risk.** A2 added a generic `no-scrollbar`
   class and applied it to two shells. The utility doesn't say
   "horizontal-strip only" — somebody will reach for it on a vertical
   list and hide a legitimate overflow scrollbar. Either rename to
   `.no-scrollbar-horizontal` + assert it's only on `overflow-x` parents,
   or audit usage on every PR. Cheap rename; do it before another
   shell adopts it.

3. **Strict-schema legacy-payload pattern.** v1.4.17 hotfix exposed
   that v1.4.16's strict insight schema didn't gracefully handle
   pre-strict cached payloads. This same shape exists in three other
   places: cached AI insights (just fixed), cached achievement summary
   shape (v1.4.16 changed it), and the comparison-overlay payload
   (v1.4.16 introduced it). **Audit every `safeParse()` call in
   `src/lib/`** and confirm there's a legacy-payload CTA path, not a
   silent crash. Not v1.5 work — a v1.4.19 cleanup pass.

4. **Achievement evaluator cost per dashboard load.** With 59
   achievements + discovery filter + summary recompute + iOS-format
   filter, evaluation runs on every `GET /api/achievements`. Each
   evaluator does its own DB query (mood entries, measurements, audit
   rows). **Profile after deploy:** if p95 over 200ms on Marc's
   account, batch-fetch + memoize. The 59-row scale is fine; the 100+
   roster I might add in v1.5 is not.

5. **`/admin/api-tokens` story isn't done.** A2 fixed the shell
   scrollbar; the table itself still has 7 columns and looks dense at
   `<lg`. A future viewport (foldable, narrow tablet) might surface
   the same complaint about the card list's button row. Worth
   spending a focused sweep (C.16 admin shell audit) before another
   user complains.

6. **Hidden-achievement DOM-leak attack surface needs lock-in.** B1
   asserts the test for "real strings absent from DOM" but if a future
   contributor adds `aria-label={achievement.title}` to an icon, the
   leak is silent. Add an ESLint rule or a Playwright assertion that
   greps the rendered page-source for any `ACHIEVEMENT_DEFINITIONS`
   string when the user hasn't unlocked it. Defense in depth; the
   existing test is necessary but not sufficient.

---

## F. Candid one-liner

HealthLog took 36 hours to ship a polish-leap, walk back three
overshoots, fix a regression that survived two earlier fixes, and patch
a crash six hours after a release — and came out of it with a higher
quality bar, a real engagement surface, and a clearer sense of which
patterns are reusable; v1.5 is now the release where those patterns
either cohere into a product or stay isolated wins.
