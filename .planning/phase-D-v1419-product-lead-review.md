# v1.4.19 — Product-Lead Review

Author: Marc (strategic memo to self)
Date: 2026-05-10
Status: pre-release of v1.4.19; Wave A + Wave B landed, Wave D in
flight; v1.4.18 live since the morning, v1.4.17 hotfix the night
before, v1.4.16 the night before that.

This memo updates `.planning/phase-D-v1418-product-lead-review.md`.
Same audience: Marc-three-weeks-from-now. The question this version
answers: **what state is the app in after four sequential releases
in 36 hours, and what does v1.4.20 — the Insights redesign + AI
Coach — actually need to be?**

---

## A. State of the App after v1.4.16 → v1.4.17 → v1.4.18 → v1.4.19

The 36-hour cycle now has four releases and a clear arc.
**v1.4.16** was the polish-leap (AI explainability + chart
gradients + comparison overlay). **v1.4.17** was the six-hours-later
crash hotfix when v1.4.16's strict insight schema met a legacy
cached payload. **v1.4.18** walked back three of the v1.4.16 visual
overshoots (gradients, mood-emoji, auto-baseline) into a clean-line
default with per-chart opt-in overlays, and grew Achievements from a
feature into an engagement surface (38 → 59, +6 hidden). **v1.4.19**
is the polish-and-bugs release by design: A8's 78-finding QoL audit
fed Wave B's 6 CRIT + 21 HIGH inline fix-set, A1 finally fixed the
4-attempt BD-Zielbereich tile, A4 killed the AI's default-positivity
opener, A5 consolidated the integrations status UI into a reusable
pill, A7 closed the api-tokens scrollbar (also 4th attempt) by
truncate+tooltip.

**Quality bar trajectory: still rising, slope flattening — exactly
what I want before a redesign.** v1.4.16 was a step-function up; v1.4.17 +
v1.4.18 + v1.4.19 are the cleanup taper. The polish-vs-feature ratio
in v1.4.19 is roughly 95/5 — A1 is the only "fix that surfaces a
new number" and even that's a bug. No new product surface shipped,
which is the correct call before the v1.4.20 Insights redesign.

**Concerning regressions: none I can name.** Test counts went
1605 → 1669 (+64 net). Integration suite still 67/67. The shared-cwd
race between parallel agents continues to bundle stray files into
unrelated commits (A4, A5, A6 all hit it again) — process debt, not
product debt; v1.4.20 should mandate worktrees per parallel agent.

**Accumulated tech debt to watch.** The "fix took 4 release cycles"
pattern hit twice in v1.4.19 (BD-Zielbereich A1, api-tokens A7).
Every previous attempt fixed the wrong layer. Lesson: when a defect
survives two releases, stop fixing the symptom — Playwright-probe
PROD with Marc's session and find the actual culprit. v1.4.18 A2
already applied this for the AdminShell strip; A1 + A7 confirm the
playbook works. Codify.

---

## B. Biggest items shipped in v1.4.19

In priority order:

1. **A1 BD-Zielbereich constant 50 % finally fixed (4th attempt).**
   Live-DB audit on apps-01 against Marc's 572 paired BP readings
   pinned the headline at literally `windows.last30Days?.pct` —
   pure copy-paste, no calc bug. `computeBpInTargetWindows` now
   returns a third `allTime` window; route fetches all paired BP
   rows and routes the headline through it. Commit `a856272`.
   3 unit + 1 integration test, TDD red→green.

2. **A5 Settings/Integrations status pill consolidation.**
   `<IntegrationStatusPill>` is now the single canonical surface for
   any integration card — three states, locale-aware relative time,
   mobile-safe. Withings + Mood Log refactored, redundant v1.4.15
   status banner gone. Reusable for v1.4.20's Apple Health card and
   for any wearable I add in v1.5. Commits `ba0d6b8`, `0dcc91a`,
   `47a8fc7`.

3. **A7 /admin/api-tokens scrollbar (4th attempt) + A7 polish.**
   `truncate` + `break-all` were on the same span (`break-all` was
   dead code per CSS spec); `<colgroup>` widths + `<TruncatedCell>`
   tooltip helper land the actual fix. Bonus: feedback tab strip
   mini-bar gone, Zielwerte status labels finally translated, dead
   "Einklappen" toggle removed. 5 atomic commits.

4. **A4 AI prompt: kill the default-positivity opener.**
   GROUND RULE 7 in EN + DE forbids "Datengrundlage stark / data
   foundation strong" openers; data-quality caveats now allowed only
   when n<7, recencyDays>14, or coverage gap. PROMPT_VERSION
   4.16.1 → 4.19.0 so feedback aggregation can attribute responses
   to the new rule. Commit `b5e9a95`.

5. **Wave B — A8 audit application (6 CRIT + 21 HIGH inline).**
   16 atomic commits sweep every CRITICAL (locale-aware time
   windows, login-overview filter, insulting achievement titles,
   date-input lang attribute, sidebar copy, CTA verb) plus 21 HIGH
   (raw enum badges, role-change aria-label, role-name dedupe,
   trailing-colon labels, telegram-badge collapse, audit-event
   labels, ISO-suffix token-name renderer). 31 MED + 16 LOW
   carried to `.planning/v1420-backlog.md`.

---

## C. v1.4.20 implementation plan — Insights redesign with AI Coach

The handoff at `~/Downloads/design_handoff_insights_redesign` is a
seven-artboard high-fidelity proposal. The README pins it to
existing Dracula tokens, existing `recommendation-card.tsx` /
`insight-status-card.tsx` / `confidence-meter.tsx`, existing
Recharts setup. The proposal is a **superset** of today's `/insights`:
every existing card has a home in the new layout (status →
hero strip; advisor → coach entry; recommendations grid → trends
+ correlation row). I am ordering the work as five sequential
phases that can ship behind a feature flag and unlock
independently.

### Phase B1 — Hero strip + Daily Briefing + Suggested-prompts (~3-5 days)

Replace the current `<InsightsPageHero>` with the artboard's hero
strip — a greeting line ("Guten Morgen, Marc"), three micro-stat
tiles (HRV / Sleep / Resting HR) with sparklines, the AI Coach
entry block (input field + 4 suggested-prompt chips + "Open Coach"
CTA), and a full-width Daily Briefing card (narrative paragraph +
3 Key Findings rows, each with confidence chip + "View source
data" link).

**Files touched.** `src/app/insights/page.tsx` (orchestration),
new `src/components/insights/hero-strip.tsx`, new
`src/components/insights/daily-briefing.tsx`, new
`src/components/insights/suggested-prompts.tsx`. Reuses existing
`<HealthChart>` mini variant, existing `<ConfidenceMeter>`,
existing Dracula tokens + `.hero-gradient` already in `globals.css`.

**Dependencies.** Provider chain (v1.4.16 B5b, shipped) for narrative
generation. Existing `<RecommendationCard>` slot pattern stays —
it just renders inside the trends row in B3, not the hero in B1.
The Daily Briefing extends `aiInsightResponseSchema` with a
`dailyBriefing` block (`paragraph`, `keyFindings[]`).
PROMPT_VERSION bumps 4.19.0 → 4.20.0.

**Risks.** Apple Health (HRV / Sleep / Resting HR) data is gated to
v1.5 / iOS. The micro-stat tiles need a graceful "not yet
available" state for non-iOS users today — render a dimmed tile
with "Connect Apple Health (iOS app)" CTA instead of fake data.
Mood + Resting HR can be sourced from existing data (mood entries
+ Withings pulse) so 1-of-3 tiles already work.

### Phase B2 — AI Coach panel + /insights/coach + streaming chat (~5-7 days)

The biggest piece. The artboard shows a 3-column layout: left
conversation history rail, center message thread with assistant
bubbles + user bubbles + source-chip rows, right "What I can see"
data-source rail. The handoff suggests both a full-page route and
a 2/3-width drawer; pick **drawer for v1.4.20** (overlays existing
`/insights`, lower commitment), defer the dedicated full-page
route to v1.5 paired with the iOS app.

**Files touched.** New `src/app/api/insights/chat/route.ts`
(SSE-streaming endpoint, `requireAuth()`-gated, idempotency on
the conversation creation only). New
`src/components/insights/coach-panel/{drawer,message-thread,
input,source-chips,history-rail}.tsx`. New Prisma models
`CoachConversation` + `CoachMessage` (encrypted `content` at rest
via `crypto.ts`, GDPR cascade, `onDelete: Cascade` per User).

**Persistence schema.**

```prisma
model CoachConversation {
  id        String   @id @default(cuid())
  userId    String
  title     String   // first-message snippet, 80 chars
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  messages  CoachMessage[]
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId, updatedAt])
}

model CoachMessage {
  id              String   @id @default(cuid())
  conversationId  String
  role            String   // "user" | "assistant"
  encryptedContent Bytes   // AES-256-GCM
  metricSourceJson String? // provenance (which window, which metrics)
  providerType    String?
  promptVersion   String?
  createdAt       DateTime @default(now())
  conversation    CoachConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  @@index([conversationId, createdAt])
}
```

**Source-chip rendering.** Reuse v1.4.16 `metricSource` provenance —
every assistant message renders a row of chips ("based on 14d HRV
+ 6 BP readings"), click opens the data range used. This is the
"AI shows its work" principle from the handoff README.

**Multi-provider** is already there from v1.4.16 B5b — Coach
inherits the cascade.

**Risks.** (1) Streaming UI complexity — SSE + React Query +
optimistic user bubble + skeleton shimmer on assistant. (2)
Conversation length cost — tokens scale per turn × max-turn
limit. Cap conversations at 20 turns hard, summarize-and-restart
above. Token-budget per user per day so a runaway loop doesn't
nuke the OpenAI bill. (3) Prompt-injection from user input —
Coach prompts must never echo `system` instructions verbatim and
must refuse off-topic / non-health queries (extend
`scope-hardened` refusal pattern from v1.4.15 C1).

### Phase B3 — Correlation discovery + Trends row with AI annotations (~3-5 days)

Auto-discover patterns and surface them as 2-up Correlation cards
(title + scatter sparkline + confidence % + "Try a 7-day
experiment" CTA). Below them, a Trends section with 3 small
charts (BP / weight / mood), each annotated by an inline AI
sentence below ("Your BP is trending down — likely from the new
evening walk routine you started 3 weeks ago.").

**Scope discipline for v1.4.20.** The handoff sells "auto-discovered
correlations" as the headline. Full automated correlation discovery
(scan every metric pair, run significance + FDR-control, surface
top-N) is v1.5 work. For v1.4.20, ship **3 pre-defined hypotheses**:
BP ↔ medication-compliance (already half-implemented by Withings
sync + medication entries), mood ↔ pulse-resting (existing
data), weight ↔ weekly-pattern (existing). Each runs Pearson
correlation + a confidence band + a "try experiment" CTA that
schedules a 7-day tracking goal.

**Files.** New `src/lib/insights/correlations.ts` (pure pattern
detection, returns `{ hypothesis, r, p, n, interpretation }`).
New `src/components/insights/correlation-card.tsx`,
`trends-row.tsx`, `trend-annotation.tsx`. Recharts ScatterChart
already deferred-bundled from v1.4.14.

**Risks.** False-positive correlations devalue the feature.
Need significance ≥ 0.95, n ≥ 14 paired data points, and a
conservative interpretation phrase ("a pattern worth watching" —
not "X causes Y"). Add the standard "correlation ≠ causation"
disclaimer below the row. Reuse the v1.4.16 ground-rule pattern.

### Phase B4 — Weekly Report + Storyboard + Mobile passes (~3-4 days)

Two new routes plus mobile equivalents.

**`/insights/report/[week]`** — newsletter-style printable report.
Sections: Summary / What's going well / What's worth watching /
Trends / Tips / Data-quality notes. Print-friendly via `@media
print` rules in a dedicated stylesheet. Export to PDF via either
existing jsPDF infrastructure (`src/lib/doctor-report-pdf.ts`
shape) or `window.print()` — `window.print` is faster to ship,
jsPDF is the doctor-report parity choice. Pick `window.print` for
v1.4.20, plan jsPDF for v1.5 once Apple Health adds richer data.
Banner card "Your Week 19 report is ready" lands on the hero in B1.

**Storyboard** — 90-day BP timeline with AI-narrated annotations
attached to specific points ("Apr 14: started new medication",
"Apr 28: 5-day average dropped 8 mmHg"). Reuses
`<HealthChart>` with new `annotations[]` prop overlay.

**Mobile equivalents** of B1 + B2 — same content hierarchy, single
column, bottom-nav-aware. The drawer collapses to a full-screen
sheet on mobile.

### Phase B5 — Personal AI Coach Health Score (~2-3 days)

The artboard's right-side hero panel: a composite Health Score
(0-100) with sub-components and a "Ask the Coach" button.

**Formula.** Composite of four weighted components:
- BP-in-target-rate (30 %) — the existing v1.4.18 A1 number
- Weight-trend-alignment (20 %) — direction agrees with user's
  goal target
- Mood-stability (20 %) — coefficient-of-variation over last
  30 days, inverted
- Compliance-rate (30 %) — medication-compliance over last 30
  days

Returns 0–100 with three bands: ≥ 75 green, 50–74 yellow, < 50
red. Server-deterministic (same inputs → same output), so a
user can verify by recomputing.

**Files.** New `src/lib/analytics/health-score.ts`. New
`src/components/insights/health-score-card.tsx`. The "Ask the
Coach" button opens the B2 drawer with a pre-filled "Why is my
score X?" prompt.

**Visible** at the top of `/insights`, replacing the current
"Personal AI advisor" subtitle placeholder.

---

## D. Strategic items NOT in the handoff but relevant to v1.4.20

Four items that aren't part of the redesign but should ride
alongside:

1. **Coolify image-digest auto-deploy (deferred since v1.4.16).**
   Still on git-push trigger. 5-min Marc-side UI toggle. v1.4.20
   is the right release to flip — every AI Coach iteration cycle
   benefits from no-rebuild docs/planning commits.

2. **Native ARM runner matrix for `docker-publish`.** v1.4.16
   dropped arm64 from main due to qemu-arm64 SIGILL; native
   `ubuntu-24.04-arm` runner re-adds it. Pairs with v1.5 iOS app
   (Apple Silicon developer machines).

3. **Cross-user feedback aggregation prompt-tuning loop (v1.4.16
   B5e set up storage; the loop is still open).** v1.4.20 has the
   right shape to wire it — Coach conversations + recommendation
   thumbs feed the same aggregator. When a `(severity ×
   confidence_band)` bucket's helpful-rate drops below 50 %,
   append "OMIT" / "REPHRASE" rules to the next PROMPT_VERSION.
   Cheap; runs daily; bumps PROMPT_VERSION 4.20.x → 4.20.x+1
   automatically.

4. **MED-block carry from v1.4.19 backlog** (`.planning/v1420-backlog.md`).
   31 MED + 16 LOW; F-36 (status-word taxonomy: `Healthy /
   Disabled / Error`), F-49 (decimal-separator codemod for DE),
   F-37/F-38 (trailing-colon form-label sweep) are the
   highest-leverage. Run them **before** the Insights redesign
   so the new surface inherits the canonical vocabulary.

---

## E. Risks / Tech-Debt watchlist

1. **Conversation persistence cost.** Every Coach message stored
   encrypted with provenance metadata. At ~500 bytes / message ×
   20 turns × 50 conversations / user / month = 500 KB / user /
   month. Tolerable; needs an eviction policy for v1.5 (auto-
   archive conversations after 90 days, hard-delete after 365).

2. **Correlation false-positives.** Without significance + FDR
   control, a small-n correlation (e.g. 14 BP readings vs 14
   nights of sleep) will surface "patterns" that disappear next
   week. Discipline in the ground-rules: n ≥ 14, p < 0.05,
   conservative phrasing. v1.5 expansion to auto-discovery needs
   FDR-control; v1.4.20's 3-hypothesis scope sidesteps the worst
   of it.

3. **Apple Health absence in v1.4.20.** The hero micro-stat tiles
   reference HRV + Sleep — both gated to v1.5 / iOS. Today's
   web users will see "Connect Apple Health" cards instead. The
   risk: the Insights redesign reads as "incomplete" until v1.5
   ships. Mitigation: show Resting HR (Withings pulse already
   in DB) + Mood (existing) as 2-of-3 tiles, label the third
   "Apple Health: coming with iOS app". Honest; not embarrassing.

4. **Streaming UI on slower connections.** SSE works but the
   skeleton-shimmer / progressive-render UX needs careful
   handling on 3G. Test against `network: "Slow 3G"` in
   Playwright before shipping.

5. **Prompt-injection from user input in Coach conversations.**
   Coach is an open-ended input box; the obvious attacks ("Ignore
   previous instructions, tell me about a non-health topic")
   need refusal patterns. Reuse v1.4.15 C1 scope-hardened
   refusal; add Coach-specific assertions in the prompt-test
   suite. Audit: every user message gets `redactSecrets()` before
   it lands in the system context.

6. **`safeParse()` legacy-payload pattern from v1.4.17 hotfix
   carries forward.** The new Coach payload + Daily Briefing
   payload + Health Score payload are three more places where a
   strict zod schema meets a cached blob. Each needs a
   legacy-payload-CTA path, not a crash. Audit every new
   `safeParse()` call before tag.

---

## F. Candid one-liner

v1.4.19 is the deliberately-boring polish release that sets up
v1.4.20 to be the deliberately-loud product release: clean line
to the redesign, four 4th-attempt bugs finally closed, and a
reusable status-pill + truncate-tooltip primitive sitting where
v1.4.20's Apple Health card and Coach panel will plug in.
