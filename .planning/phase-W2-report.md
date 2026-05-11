# Wave 2 — Insights surface polish (v1.4.22)

Started: 2026-05-10T20:40+02:00
Completed: 2026-05-10T21:00+02:00
Branch: develop (post-v1.4.21)
Six atomic commits delivered to `origin/develop`.

## A1 — BD-Zielbereich headline re-anchor

`fix(analytics): BP target headline reads last-30d, all-time becomes sub-row`

Up to v1.4.19 the headline pinned to `windows.last30Days?.pct` — a
literal copy of the 30T sub-value, producing the 50/50/50 algorithmic
pin Marc reported. v1.4.19 A1 routed the headline to `allTime`, which
fixed the pin but introduced a new emotional problem: the headline
became the slowest-moving aggregate possible, punishing recent
improvement.

v1.4.22 A1 re-anchors the route's `bpInTargetPct` to
`windows.last30Days?.pct` and adds a new `bpInTargetPctAllTime` field
so the long-arc number stays accessible as a sub-value. The
`computeBpInTargetWindows()` helper is unchanged — only the route's
headline pick changed.

**Files touched**: `src/app/api/analytics/route.ts`,
`tests/integration/bp-in-target.test.ts` (two new integration cases
pinning the headline source + all-three-windows envelope shape).

## A2 — BD-Kachel feature parity

`feat(insights): BP tile gains trend arrow + comparison overlay parity`

Up to v1.4.21 the BD-Zielbereich tile was the only one in the strip
without a trend arrow, 7-day-trend chip, or comparison overlay caption.
Synthesised a slope from the difference between the 7-day and 30-day
in-target shares: 7d > 30d means recent improvement (up-good ⇒ green
arrow). The 7-day-trend chip uses the same delta.

Extended `<TrendCard>` with optional `avgAllTime` / `avgAllTimeLabelKey`
/ `avgAllTimeColorClass` props so the all-time aggregate stays visible
next to `7d:` and `30d:` after the A1 re-anchor. Other tiles leave the
field undefined so the third sub-row never renders for them.

**Files touched**: `src/components/charts/trend-card.tsx`,
`src/components/charts/__tests__/trend-card-all-time.test.tsx` (new),
`src/app/page.tsx`, `messages/{en,de}.json` (new
`charts.avgAllTimeShort` key).

## A3 — Comparison-Toggle → global Settings

`feat(settings): comparison-overlay becomes a global dashboard preference`

Per `feedback_settings_no_split.md`, removed the on-surface
`<CompareToggle />` from `/insights`. The canonical picker already
lives in Settings → Dashboard (since v1.4.16 phase B8), and the
`User.dashboardWidgetsJson.comparisonBaseline` field already persists
the value. Every chart on `/insights` still reads the resolved
baseline so flipping the Settings toggle propagates atomically.

**Files touched**: `src/app/insights/page.tsx` (removed the meta-slot
`<CompareToggle />` from `<DailyBriefing>` and the matching import),
`src/app/__tests__/insights-polish.test.ts` (new A3 describe-block
asserting the toggle is gone but `compareBaseline` plumbing remains).

## A4 — Insights layout normalisation

`fix(insights): row-fill rule + equal-height trends + hide-on-insufficient-data`

Three related layout polish wins:

- **Row-fill rule**: BP-medication grid, weight-correlation grid, and
  medications-per-day grid all hard-coded `xl:grid-cols-2` /
  `sm:grid-cols-2`, leaving half-rows of empty space when one of the
  two slots wasn't populated. All three now switch to a single
  full-width column when fewer than 2 cards render.
- **Trends row equal heights**: each `<TrendsRow>` card is a flex
  column with `min-h-[300px]` so a multi-line AI annotation under one
  chart doesn't push that card taller than its neighbours.
- **Hide insufficient correlations**: `<CorrelationRow>` drops cards
  whose `status !== "ok"` instead of painting a placeholder. Zero ok
  cards hides the row entirely (no header, no disclaimer); 1 card
  spans 100 % width; 2-3 cards split 50/50 on `>=md`.

**Files touched**: `src/components/insights/correlation-row.tsx`,
`src/components/insights/trends-row.tsx`,
`src/components/insights/__tests__/correlation-row.test.tsx`,
`src/app/insights/page.tsx`.

## A5 — "Muster" rename + section tabs lift

`feat(insights): rename "Muster" + lift section tabs above the hero`

- **DE rename decision**: "Muster" → "Zusammenhänge". The W1b research
  suggested "Trends" or "Zusammenhänge"; picked the latter because the
  row directly above the correlation row already uses "Trends" for the
  trend-annotation strip. "Zusammenhänge" carries the relational
  meaning a correlation surface needs without borrowing terminology
  from its neighbour.
- **EN parallel**: "Patterns" → "Relationships" for the same reason.
- **Tab lift**: `<InsightsSectionNav>` moved from below the advisor
  card to the top of the page. Sticky scroll-anchored behaviour
  preserved (incremental — a full SPA-tab rewrite is out of scope for
  v1.4.22 polish). The user lands on Allgemein by default and sees
  the metric-tab strip before scrolling.

**Files touched**: `messages/{en,de}.json`, `src/app/insights/page.tsx`,
`src/components/insights/__tests__/correlation-row.test.tsx`,
`src/components/insights/__tests__/correlation-card.test.tsx`.

## A6 — Token-leak fix + DE component labels

`fix(insights): strip metric tokens in recommendation prose + DE component labels`

W1a §3 traced the production "metric:WEIGHT" leak to
`src/components/insights/recommendation-card.tsx:336`: every other
AI-prose surface ran through `stripChartTokens()`, the recommendation
text didn't. Two-line fix.

The bonus DE-locale defect: `componentMood: "Mood"` (English in the
German file) plus the related `componentBp: "BD"` /
`componentCompliance: "Medis"` abbreviations. Marc reported "Mut" —
voice-to-text rendering of "Mood". All four labels now read natively
German: `"Blutdruck"`, `"Gewicht"`, `"Stimmung"`, `"Einnahmetreue"`.

i18n integrity test added to pin the four DE component labels so a
copy-paste regression can't reintroduce the leak.

**Files touched**: `src/components/insights/recommendation-card.tsx`,
`src/components/insights/__tests__/recommendation-card.test.tsx`,
`messages/de.json`,
`src/lib/__tests__/i18n-locale-integrity.test.ts`.

## Test delta

| Layer         | Before                 | After                              |
| ------------- | ---------------------- | ---------------------------------- |
| Unit (vitest) | 2036 tests / 238 files | 2049 tests / 239 files             |
| Integration   | (covered separately)   | +2 cases in `bp-in-target.test.ts` |

13 new unit cases + 2 new integration cases. All green.

## Decisions logged

- **DE rename**: "Zusammenhänge" over "Trends" — relational meaning,
  doesn't collide with the Trends-row title directly above.
- **Section tabs**: kept the scroll-anchored sticky strip and lifted
  it above the hero. A full SPA-tab rewrite is deferred (v1.5+).
- **All-time sub-value**: rendered as a third `<span>` inside the
  existing `flex gap-3` sub-row so on mobile it wraps naturally below
  `7d:` and `30d:` instead of crowding into a single line.
- **Synthetic slope**: BP-tile uses `slope = (pct7 - pct30) / 30` as
  the slope-per-day signal. Confidence pinned to 1 because the source
  is a deterministic difference, not a regression fit.
