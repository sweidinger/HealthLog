# Phase B4 — Weekly Report + Storyboard + Mobile passes (v1.4.20)

Status: complete
Date: 2026-05-10
Branch: `develop`

## Scope

Continues the Insights redesign with the printable weekly report
route, AI-narrated storyboard annotations on the 90-day BP chart,
and mobile passes for the B1 hero + B2 Coach drawer. Strategic
plan: `.planning/phase-D-v1419-product-lead-review.md` § "Phase B4 —
Weekly Report + Storyboard + Mobile passes".

## Commits on `origin/develop`

1. `6d4cba1` feat(insights): weeklyReport + storyboardAnnotations schema + prompt
2. `8f18c7f` feat(insights): /insights/report/[week] printable weekly report
3. `f186845` feat(insights): hero strip weekly-report banner card
4. `ff1e335` feat(charts): storyboard annotations on HealthChart
5. `ebb2bc0` feat(coach): mobile rail trays for the AI Coach drawer
6. (this commit) docs(planning): mark B4 complete + report

## What shipped

### 1 · Schema + prompt (commit 1)

- `weeklyReportSchema` — ISO week + summary (10..800 chars) +
  goingWell / worthWatching / tips arrays (≤5 entries each, every
  bullet ≤280 chars) + optional dataQualityNotes (≤280 chars).
- `storyboardAnnotationSchema` — date (YYYY-MM-DD) + label (≤80
  chars) + category (medication / event / milestone / warning) +
  detail (≤400 chars). Hard array cap 20.
- Both blocks are `nullable().optional()` on the response root so
  legacy 4.20.1 caches round-trip.
- PROMPT_VERSION bumped 4.20.1 → 4.20.2.
- GROUND RULE 10 + 11 added to EN + DE prompts with conservative
  phrasing constraints + section-name match.

### 2 · `/insights/report/[week]` (commit 2)

- New `src/lib/insights/week-iso.ts` with `parseWeekISO`,
  `toWeekISO`, and `weekISOToRange`. Pure helpers, full unit suite.
- New `src/components/insights/weekly-report-view.tsx` split into
  `<WeeklyReportView>` (consumes advisor query + auth) and
  `<WeeklyReportPresentation>` (pure layout). The split keeps the
  vitest tests free of TanStack Query setup.
- New `src/app/insights/report/[week]/page.tsx` — thin client
  wrapper. Malformed slug → 404 via `notFound()`. `?print=1` query
  triggers `window.print()` after first paint.
- Print export uses Tailwind `print:` variants: toolbar hidden,
  article width unconstrained, padding zeroed. A4 / Letter both
  print without margin clipping.
- Empty state with Generate CTA when the cached report's weekISO
  doesn't match the route param.
- EN + DE i18n keys under `insights.report.*`.

### 3 · Hero banner card (commit 3)

- New `weeklyReportReady?: { weekISO, href }` prop on
  `<HeroStrip>`. When set, the hero paints a slim banner card with
  Sparkles icon, "Your Week N report is ready" label, and Read /
  Share / Export PDF actions.
- Read → in-app `<Link>` to the report URL.
- Share → `navigator.share()` when supported, else
  `navigator.clipboard.writeText` + sonner toast acknowledgement
  (success or failure).
- Export PDF → deep-links to the report URL with `?print=1` so the
  report page auto-fires `window.print()` after first paint.
- The insights page derives `weeklyReportReady` from
  `advisor.payload.insights.weeklyReport` so the banner appears
  the moment a fresh PROMPT_VERSION 4.20.2 generation lands.
- EN + DE i18n keys under `insights.heroBanner.*`.

### 4 · Storyboard annotations on `<HealthChart>` (commit 4)

- Additive `annotations?: Array<{ date, label, color }>` prop on
  `<HealthChart>`. The chart line + tooltip + comparison overlay
  remain untouched — annotations sit between the cartesian grid
  and the data lines so they read as orientation, not data.
- New pure helper `resolveAnnotationPositions()` maps annotation
  dates onto the bucketed point indices with a 7-day snap window
  (so annotations don't stack on monthly buckets) and a 24-char
  truncation precomputed for `<sm` rendering. Full unit suite.
- The `/insights` page wires advisor.payload.insights.
  storyboardAnnotations into the 90-day BP chart, mapping the four
  canonical categories to Dracula colours (medication=pink,
  event=cyan, milestone=green, warning=orange).
- Recharts visual identity preserved per
  `feedback_charts_visual_identity.md` — the additive
  `<ReferenceLine>` does NOT change the existing line/area visuals.

### 5 · Mobile rail trays (commit 5)

- The history rail (left) and sources rail (right) were desktop-only
  since B2b. B4 surfaces them on `<lg` via two chevron-button
  triggers anchored to the inside edges of the message thread.
- Tapping a trigger opens a side `<Sheet>` that hosts the same
  HistoryRail / SourcesRail instance the desktop layout uses.
- Refactored the drawer body into a separate
  `<CoachDrawerBody>` component — pure-presentational shell,
  parent owns state. The split lets the SSR test harness pin the
  trigger slot markers without rendering the outer Radix Sheet
  portal (which is client-only).
- Selecting a conversation from the mobile history tray closes the
  tray automatically so the user lands back on the message thread.

## Verification gates

- `pnpm typecheck` — clean.
- `pnpm lint` — 13 pre-existing warnings (none introduced by B4).
- `pnpm test --run` — 1902 → 1975 tests (+73). Test files 230 → 235.
- `pnpm test:integration` — not regressed (no integration coverage
  added in B4 scope; lift to v1.4.21 if/when the report route grows
  a server endpoint).

## Print verification

`window.print()` produces a clean A4 / Letter print. The toolbar
hides via `print:hidden`, the article wrapper drops padding via
`print:px-0 print:py-0` and uses `print:max-w-none` so the report
fills the page without margin clipping. Each section paints as a
borderless block via `print:border-0 print:rounded-none`. JsPDF
parity (matching the doctor-report style) remains v1.5 work as
scoped.

## Memory-care

- `feedback_charts_visual_identity.md` — Recharts kept; the
  annotation rendering uses Recharts' built-in `<ReferenceLine>`
  primitive without touching the existing chart line / area /
  tooltip visuals.
- `feedback_marc_voice_english.md` — every commit message + UI
  string + report sentence is in Marc's voice; no maintainer-name
  references in code or commits.

## Deferred / not shipped

- jsPDF parity for the weekly report (matches doctor-report style)
  → v1.5 once Apple Health adds richer data per the strategic
  plan.
- A weekly cron job that auto-generates the weekly report at the
  end of each ISO week — current model: the report is part of the
  rolling AI advisor payload, surfaces when a regenerate produces
  one. Future work could schedule it via pg-boss.
- Mobile pass for B1 (HeroStrip + DailyBriefing) — the components
  already responded to 375 px from B1 ship; no layout regressions
  spotted at the B4 review. Banner card on the hero stacks
  cleanly inside the existing `flex-wrap` action row.

## UX decisions worth flagging for review

1. **Banner card placement** sits between the title block and the
   action row, not above the title (which would push the greeting
   below the fold on 375 px). Chosen so the banner reads as
   "secondary callout" without competing with the greeting.
2. **Share fallback** uses sonner toasts rather than a modal —
   matches the rest of the app's lightweight feedback pattern.
3. **Storyboard annotation snap window** is 7 days. Wider snaps
   (e.g. 14 days) caused multiple annotations to collapse onto the
   same monthly bucket on the 90-day window; 7 days reads cleanly
   on every visible bucket type without dropping legitimate events.
4. **Mobile trays use the same rail components** as the desktop
   layout. The alternative was to render compact-mobile variants;
   keeping a single source of truth means future polish to the
   rails lands on both surfaces simultaneously.
