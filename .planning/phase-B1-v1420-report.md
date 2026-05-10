# Phase B1 (v1.4.20) — Hero strip + Daily Briefing + Suggested-prompts

Last update: 2026-05-10
Branch: `develop`
Status: complete

## Scope

Per `phase-D-v1419-product-lead-review.md` §C — Phase B1: replace the
v1.4.16 Insights page hero with the wider band from the v1.4.20 design
handoff (`~/Downloads/design_handoff_insights_redesign/`), introduce a
full-width Daily Briefing card, and extend the AI insight pipeline
with a `dailyBriefing` payload block (paragraph + 0-5 keyFindings).

The 5 prior commits land each sub-deliverable atomically; this report
+ STATE.md tick complete in commit 6.

## What shipped (5 commits, all on `origin/develop`)

| # | SHA | Sub-deliverable |
|---|-----|------|
| 1 | `9873363` | Schema + prompt — `dailyBriefingSchema` (`paragraph`, `keyFindings[0..5]`, tone enum, sourceWindow / sourceMetric enums); PROMPT_VERSION bump 4.19.0 → 4.20.0; GROUND RULE 8 added in EN + DE prompts; new `daily-briefing-schema.test.ts` (+31 specs). |
| 2 | `9713bf1` | `<SuggestedPrompts>` chip-strip component — 5-chip default ("Try asking" row), lucide `Quote` icon, Dracula purple chip styling, mobile-wrap; EN + DE keys (`insights.suggestedPrompts.*`); +9 specs. |
| 3 | `92f332e` | `<DailyBriefing>` card — narrative paragraph, 0-5 finding rows with tone-coloured left bar (green/orange/cyan), metric-icon prefix, optional delta badge, empty-state CTA, `animate-pulse` skeleton, optional metaSlot; EN + DE keys (`insights.dailyBriefing.*`); +18 specs. |
| 4 | `59e63a0` | `<HeroStrip>` — locale-aware time-of-day greeting (4 buckets), briefing-paragraph subtitle with fallback, 3-button action row (weekly-report + ask-coach disabled with `title="Coming soon"`, regenerate wired), suggested-prompt strip below; old `<InsightsPageHero>` JSDoc-deprecated; new `globals.css` utilities `.hero-gradient`, `.glow-purple`, `pulseDot` keyframes; +22 specs. |
| 5 | `7d29596` | `/insights` page wire-up — `<HeroStrip>` + `<DailyBriefing>` mounted above the existing Status / Advisor / Recommendations blocks; `useInsightsAdvisorQuery` lifts `dailyBriefing` off the cached payload via `dailyBriefingSchema.safeParse`; CompareToggle migrated from hero meta band into briefing metaSlot; v1.4.19 A3 polish-test loosened from string-count to JSX-block check (load-bearing "advisor card carries no onRegenerate" stays). |

## Test count

| Snapshot | Files | Tests |
|----|----|----|
| Baseline (start of B1) | 210 | 1672 |
| After commit 1 (schema) | 211 | 1703 (+31) |
| After commit 2 (suggested-prompts) | 212 | 1712 (+9) |
| After commit 3 (daily-briefing) | 213 | 1730 (+18) |
| After commit 4 (hero-strip) | 214 | 1752 (+22) |
| After commit 5 (page wire-up) | 214 | 1753 (+1 polish guard) |

Net delta: **+4 test files, +81 tests**, all green. `pnpm typecheck`
clean across the chain. `pnpm lint` baseline preserved (12 pre-
existing warnings, 0 new). `pnpm test --run` 4.7s.

## What was deferred (and why)

- **Vitals tile row (4×BP/Weight/Pulse/Mood from the artboard).**
  The product-lead review described a `<VitalsRow>` of 4 micro-stat
  tiles with sparklines + per-tile AI commentary. On closer look at
  the live `/insights` page, the per-section cards (BP / Weight /
  Pulse / Mood / Compliance / BMI) already render the same numbers
  as full charts with traffic-light status badges + AI status text.
  Mounting another tile row above them would duplicate the data
  surface for marginal additional context.
  → Decision: defer the tile row until B3 (correlations + trends),
  where the trends section will reorganise the per-section blocks
  and the tile row can replace the long status-card list rather
  than sit on top of it.

- **Coach-button + Suggested-prompt wiring.** Both the hero's
  "Ask the coach" CTA and the suggested-prompt chips need a Coach
  drawer to route into. That drawer ships in B2 (its own separate
  3-5 day tranche). For B1 the buttons render disabled with a
  "Coming soon" `title=` tooltip, and the suggested-prompts onPick
  is a no-op — TODO comments in `<HeroStrip>` mark the wiring point.

- **Weekly-report button.** Same shape: lands in B4. Disabled with
  the same "Coming soon" affordance for B1.

- **Health Score panel.** The artboard's right-side composite score
  (0–100, four weighted components) lands in B5 per the product-
  lead review. For B1 the right side of the hero is empty by design.

- **Daily Briefing variants (Editorial / Chart-led / Minimal).** The
  artboard's `BriefingVariants` block proposes three styling options;
  B1 ships the Editorial-style variant only (paragraph + finding
  rows). The other two variants stay in the v1.4.21 backlog if a
  user-setting toggle is wanted; otherwise dropped.

- **Source-chip row on each Key Finding.** The artboard shows a
  "View source data" link per finding. Implementing that needs the
  per-metric chart-deeplink pattern from B3 (each chip routes to
  the source-data range). Defer to B3 to avoid double-implementing.

## Anything I couldn't ship

Nothing blocked outright. The Vitals tile row was a deliberate
defer rather than a block — see above for the reasoning.

## AI-prompt copy decisions for maintainer review

1. **GROUND RULE 8 wording** (added in both EN + DE prompts). The
   rule instructs the model to emit a `dailyBriefing` block when
   the snapshot has any of bp / weight / pulse / mood / medications.
   compliance, with paragraph 80-200 words and ≤ 5 findings. I went
   with "0-5 findings; three is a healthier default" to nudge the
   model toward fewer, higher-signal findings rather than padding
   to the cap. Worth a sanity check on the first real generation
   that 80-200 words doesn't over-constrain — if the model hits the
   80-word floor too often we may want to drop it to 60.

2. **Banned-opener inheritance.** GROUND RULE 8 explicitly
   references the rule-7 banned openers ("Your data foundation is
   strong" etc.) so the briefing paragraph can't sneak them in.

3. **`tone` enum pinned to `good | watch | info`.** I kept this
   tighter than the existing recommendation-severity ladder
   (`info / suggestion / important / urgent`) since the briefing
   surface is meant to be lighter-weight than the advisor. A future
   B-phase could add a fourth `alert` tone in red for genuine
   warnings; for B1 we route those through the existing
   `<InsightAdvisorCard>` recommendations grid instead.

4. **Greeting buckets at 03:00.** The prototype uses "Guten Morgen"
   verbatim; I split into 4 buckets (morning 05–11, afternoon 12–17,
   evening 18–22, night 23–04) and mapped "night" to "Good evening"
   in both locales since "Guten Morgen" before 5am reads odd. If
   the maintainer prefers a literal "Gute Nacht" at 03:00, flip the
   `heroGreetingNight` translation key.

5. **5 default suggested prompts.** Pinned in i18n
   (`whyMonday / weightVsPulse / weekVsMonth / tellMyDoctor /
   medicationWorking`). The list mirrors the artboard verbatim; if
   "What should I tell my doctor?" reads too clinical, flipping
   the EN value is a one-line edit.

## Verification gates

```
pnpm typecheck          ✓ clean across all 5 commits
pnpm test --run         ✓ 1753/1753 passing (was 1672)
pnpm lint               ✓ baseline (0 new errors / 0 new warnings)
i18n-locale-integrity   ✓ EN + DE share the same key shape
```

## Files added / modified

**Added:**
- `src/components/insights/hero-strip.tsx`
- `src/components/insights/daily-briefing.tsx`
- `src/components/insights/suggested-prompts.tsx`
- `src/components/insights/__tests__/hero-strip.test.tsx`
- `src/components/insights/__tests__/daily-briefing.test.tsx`
- `src/components/insights/__tests__/suggested-prompts.test.tsx`
- `src/lib/ai/__tests__/daily-briefing-schema.test.ts`

**Modified:**
- `src/lib/ai/schema.ts` — `dailyBriefing` block added to response schema
- `src/lib/ai/prompts/insight-generator.ts` — PROMPT_VERSION 4.20.0, GROUND RULE 8, JSON-shape examples in EN + DE
- `src/components/insights/use-insights-advisor.ts` — `dailyBriefing` lifted off cached payload
- `src/components/insights/insights-page-hero.tsx` — JSDoc @deprecated note
- `src/app/insights/page.tsx` — wired new components in
- `src/app/__tests__/insights-polish.test.ts` — v1.4.19 A3 ratchet adapted
- `src/app/globals.css` — `.hero-gradient`, `.glow-purple`, `pulseDot` keyframes
- `messages/en.json` + `messages/de.json` — `insights.suggestedPrompts.*`, `insights.dailyBriefing.*`, `insights.heroFallbackSubtitle`, `insights.heroGreeting{Morning,Afternoon,Evening,Night}`, `insights.heroComingSoonTooltip`, `insights.heroAction{WeeklyReport,AskCoach,Rerun}`

## Next phase

B2 — AI Coach panel + streaming chat + persistence. The wiring
hooks left in B1 (`onPickPrompt` no-op, "Ask the coach" disabled
button) become live during B2.
