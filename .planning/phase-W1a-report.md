# Wave 1a — PROD probe + token-leak hunt + backlog inventory (v1.4.22)

Started: 2026-05-10T20:20+02:00
Branch: develop (post-v1.4.21)
Production probed: `https://healthlog.bombeck.io` (image digest
`sha256:4e818d44702c…`, v1.4.21)
Probe scripts (read-only, no commits):
- `.planning/v1422-w1a-tokens-probe.mjs` (admin/api-tokens overflow walk)
- `.planning/v1422-w1a-insights-probe.mjs` (Insights `Metrik` / token leak hunt)
- `.planning/v1422-w1a-targets-probe.mjs` (Zielwerte page screenshot)

## 1. BD-Zielbereich tile

### What I see today

`src/components/charts/trend-card.tsx` paints the BD tile in the
shared `<TrendCard>` chrome:

- **Headline (3xl bold):** `latest = data.bpInTargetPct` — routed through
  `windows.allTime?.pct` since v1.4.19 A1. For the live tenant this is
  ~10.8 % rounded to 11 %.
- **Sub-row (`mt-auto` muted text-xs):** `7d: <avg7> · 30d: <avg30>` —
  `data.bpInTargetPct7d / pct30d`. For the live tenant, both 50 %.
- No window label on the headline. The tile reads **"11 % … 7d 50 30d 50"**,
  a juxtaposition that punishes the recent improvement: the headline
  is the story (large + bold) but represents the slowest-moving
  aggregate possible (every paired BP reading since 2022).

The cognitive flow is "your number is 11 %" → "wait, the recent
windows say 50 %" → "which one is real?". Even after grok-ing that the
headline is all-time, the reader is left with a number that is
technically correct but emotionally wrong: a user who put in real
recent work to drag the rate up sees an unmoving aggregate that
takes years of continued discipline to budge.

### Three proposals (recommend one)

#### A) Re-anchor headline to last-30d, surface all-time as a sub-value

Pro:
- The dashboard tile becomes a "what's happening now" widget, matching
  every other tile on the page (weight, pulse, mood — all show recent
  reading + 7d/30d). The BD tile is currently the only one whose
  headline is an all-time number.
- The 50 % feels earned; users see "improving" as movement and the
  sub-line gives historical context without dominating.
- One-line API change: `bpInTargetPct = windows.last30Days?.pct` plus
  a new field `bpInTargetPctAllTime` for the sub-row.

Con:
- Inverts the v1.4.19 A1 fix story. Need a backlog entry to clarify
  that the v1.4.19 fix was about *correctness* (the headline was
  silently equal to the 30-day) and v1.4.22 is about *framing* (the
  all-time aggregate belongs in the small text).
- Cache invalidation on the `analytics` query (existing TanStack
  pattern handles this).

#### B) Explicit window label "Allzeit / All time" on the headline

Pro:
- Smallest diff. Add a `<span className="text-xs text-muted">{t(
  "dashboard.bpInTargetAllTimeLabel")}</span>` next to the 11 %. No
  data-shape change, no API change.
- Honours the v1.4.19 A1 contract verbatim — the headline still
  surfaces the slowest-moving number.

Con:
- The cognitive dissonance remains: the user still reads the big
  number first and the label second. A 50 % → 50 % → 11 % "punishment
  reading" persists; the label only confirms why.
- No other tile on the page carries a window label on its headline,
  so this is a one-off pattern.

#### C) Three-window chip row (no headline) — replace big-number layout

Pro:
- Renders the tile as three equal-weight chips: `7d 50 % · 30d 50 % ·
  Allzeit 11 %`. No single number dominates; the user picks the
  window that matters to them.
- Visually distinct enough to break the "every TrendCard is identical"
  uniformity, which signals to the user that BP-in-target is a
  conceptually different metric than weight / pulse.

Con:
- Largest design lift. Diverges from the shared `<TrendCard>` chrome
  used everywhere else on the dashboard, so either (a) BD tile gets
  a bespoke `<BpInTargetTile>` component, or (b) the shared TrendCard
  picks up an optional "windowed mode". Either is a Wave-2/3 redesign
  item, not a Wave-4 polish patch.
- Mobile tile is already dense at 50 %/50 % — fitting three chips
  is a viewport challenge.

### Recommendation: **A** (re-anchor to last-30d, all-time → sub-row)

Smallest UX win for the smallest engineering lift, and aligns the BD
tile with every other tile on the dashboard. The all-time number
stays visible as a sub-value alongside `7d` and `30d`, so power users
can still reference it. The v1.4.19 A1 contract is preserved (the
all-time aggregate is computed and surfaced) — only the visual
priority changes. The fix is roughly:

- `src/app/api/analytics/route.ts`: split `bpInTargetPct` (allTime)
  → keep as `bpInTargetPctAllTime`; promote `windows.last30Days.pct`
  to the new `bpInTargetPct` headline.
- `src/components/charts/trend-card.tsx` — extend `<TrendCard>` with
  an optional `tertiaryAvg` slot OR (cleaner) accept a third
  sub-value pair (`avgAllTime`, `avgAllTimeLabel`) and render it as
  `· Allzeit: <pct> %` next to `7T:` and `30T:`. Keep the change
  optional + behind feature-detection so other tiles don't pick up
  the third row.
- Tests: `bp-in-target.test.ts` already pins the three-window
  contract; add a `<TrendCard>` test that asserts the headline
  matches the 30-day pct when both are passed.

## 2. Admin / api-tokens scrollbar

### Per-viewport probe results

| Viewport            | viewport×inner | doc overflow | body overflow | Real culprit                               |
| ------------------- | -------------- | ------------ | ------------- | ------------------------------------------ |
| iphone-se 375×667   | 375 / 375      | NO           | NO            | (none — only the intentional `nav.no-scrollbar` mobile section strip) |
| pixel5 393×851      | 393 / 393      | NO           | NO            | (none — same intentional nav)              |
| ipad-mini 768×1024  | 768 / 768      | NO           | NO            | `<div class="hidden overflow-x-auto md:block">` (intentional `auto`, BUT triggers because the inner table overflows) — table sw=212, cw=122, delta=90 |
| desktop 1280×800    | 1280 / 1280    | NO           | NO            | Same wrapper. Table sw=663, cw=634, delta=29 |

### Real culprit

**The desktop table overflows its `overflow-x-auto` wrapper at md+ even
on a 1280-wide desktop viewport.**

Selector: `div.hidden.overflow-x-auto.md:block` →
`table.w-full.table-fixed.text-sm` (file:
`src/components/admin/api-token-overview-section.tsx:145-238`).

Why the table overflows even with `table-fixed` + percentage colgroup:

1. The "Last used" column (`<col className="w-[12%]" />`) carries
   `whitespace-nowrap` (line 225) and renders strings like
   `"05.05.2026, 21:46"` (~14 chars after locale) → ~110 px at the
   table's font size.
2. The "Created" column (`<col className="w-[8%]" />`) also carries
   `whitespace-nowrap` (line 230) and renders the same locale-aware
   `"05.05.2026"` ~80 px wide.
3. At 1280 px viewport with sidebar 220 px + gap 24 px + page padding
   ~64 px, the card's content area ≈ 700 px. 12 % of 700 = 84 px,
   8 % = 56 px. The `whitespace-nowrap` strings (~110 + ~80 px)
   overflow their colgroup-allotted percentages.
4. `whitespace-nowrap` wins over `table-fixed`'s width contract, so
   the table's intrinsic width exceeds 100 %. The wrapper's
   `overflow-x-auto` then paints a horizontal scrollbar to let the
   user see the clipped columns — **that is the scrollbar Marc keeps
   reporting**.

Visual confirmation: `/tmp/v1422-w1a/desktop-fullpage.png` shows the
"Last used" and "Create" headers truncated mid-word and the rightmost
date strings clipped (e.g. "05/05/" with the year cut off).

### Concrete fix path

Three options, in order of preference:

1. **Drop `whitespace-nowrap` on the date cells** (lines 225, 230).
   `formatDateTime("05.05.2026, 21:46")` is two semantic chunks; let
   it wrap to two lines on narrow viewports. The card grows by one
   row but no scrollbar — and the desktop case at >1024 px already
   fits the unwrapped string in 12 %.

2. **Compact date format on the "Last used" column.** Use
   `formatDateShort()` (already in `src/lib/format.ts:51`) which
   drops the year. "05.05" + time fits in 70 px; the trailing
   tooltip already exposes the full timestamp on hover.

3. **Hide the "Created" column on md (768-1023 px).** Add a
   `hidden lg:table-cell` to the 6th `<col>` + `<th>` + `<td>`. The
   tablet user trades one column for a clean layout; desktop keeps
   everything.

Option 1 is smallest diff (two-line change, no i18n surface impact).
Option 2 is the cleanest UX. Option 3 is what the "User"/"Permissions"
columns already do via the mobile card-list — same pattern, one
breakpoint up.

## 3. Raw `metric:<TYPE>` token leaks

### Where they emit

The Playwright probe captured the literal substrings rendered in the
production /insights page (German locale, live-tenant data):

| Match                       | Context (rendered prose, last 60 + 60 chars)                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `metric:BLOOD_PRESSURE_SYS` | "…strukturiertes Gegensteuern sinnvoll ist. metric:BLOOD_PRESSURE_SYS\n\nZuletzt aktualisiert"  |
| `metric:BLOOD_PRESSURE_SYS` | "…Medikation mit niedrigeren systolischen Werten einhergeht. metric:BLOOD_PRESSURE_SYS\n\n…" |
| `metric:WEIGHT`             | "…damit ich die BMI-Klassifikation präzise berechnen kann. metric:WEIGHT\n\nZuletzt aktualisiert" |
| `metric:PULSE`              | "…und aktuell, daher ist die Aussage belastbar. metric:PULSE\n\nZuletzt aktualisiert"          |
| `metric:MOOD`               | "…nur 4 % Zielbereichstreffern in den letzten 30 Tagespunkten. metric:MOOD\n\nZuletzt aktualisiert" |
| `metric:BLOOD_PRESSURE_SYS` | "…regelmäßig nur eine von zwei geplanten Tagesdosen. metric:BLOOD_PRESSURE_SYS\n\nZuletzt aktualisiert" |

The `Zuletzt aktualisiert: …` timestamp tail is the per-section
advisor card footer — so the leak is appearing at the END of an
**advisor card recommendation text** (not in the `summary` or
`primaryRecommendation`, both of which are stripped).

### Where the strip is missing

`src/components/insights/recommendation-card.tsx:336`:

```tsx
<p className="text-sm leading-snug">{norm.text}</p>
```

`norm.text` (= `rec.text`) is rendered **directly without
`stripChartTokens()`**. Every other AI-prose surface on the page —
`insight.summary` (line 594), `insight.primaryRecommendation` (line
573), `finding.label` (line 622), `finding.guideline` (line 631) —
runs through `stripChartTokens()`. The recommendation text is the one
field the v1.4.19 A3 widening missed.

The model is following its own prompt (it embeds `metric:WEIGHT` etc.
in the rec text expecting an inline mini-chart), but the rec-card's
chart slot lives in the EXPANDED rationale block (line 226-234, only
visible after the user clicks the chevron), so the token has nowhere
to be consumed in the always-visible rec text — it just leaks.

### Concrete fix

Two-line diff:

```diff
- <p className="text-sm leading-snug">{norm.text}</p>
+ <p className="text-sm leading-snug">{stripChartTokens(norm.text)}</p>
```

plus the `import { stripChartTokens } from "@/lib/insights/chart-tokens";`
at the top of `recommendation-card.tsx`.

Backstop test in the existing `insights-polish.test.ts` describe-block
(`v1.4.19 A3 — chart-token leak hardening`) — add an
`it("RecommendationCard strips metric:* tokens from rec.text")` case
that mounts a rec with `text: "increase fluids. metric:WEIGHT"` and
asserts the rendered DOM does NOT contain `metric:WEIGHT`.

### Bonus translation defect uncovered en route

Marc reported "Metrik Mut" — the actual rendering on prod is the
**Health-Score sub-bar label**, which surfaces "Mood" verbatim in
German because `messages/de.json:778` says:

```json
"componentMood": "Mood",
```

instead of `"Stimmung"`. The label is rendered by
`src/components/insights/health-score-card.tsx:65` via
`COMPONENT_LABEL_KEY.mood = "insights.healthScore.componentMood"`.

One-character fix. Worth bundling into the same Wave-4 patch so
"the BP/Weight/Mood/Meds row" reads natively German.

## 4. Targets / Zielwerte page

### Current state (probe screenshots)

`/tmp/v1422-w1a-targets/desktop.png` (1280×900) and
`/tmp/v1422-w1a-targets/pixel5.png` (393×851).

The page is a 2-col (desktop) / 1-col (mobile) grid of identical
`<TargetCard>` instances. Each card has:

- Card header: icon + label + small trend arrow (TrendingUp/Down/Minus)
- Big-number current value (with unit and 30-day mean line)
- Horizontal three-zone range bar (red / yellow / green) with a dot
  marker for the current value
- Status pill (e.g. "Optimal", "Im Zielbereich", "Moderat")
- External-link to the source guideline (WHO BMI / ESH 2023 /
  CDC/NCHS …)

Compared to `/dashboard` and `/insights` the page is visually
**static and reference-y**:

- No 7-day delta. Only the 30-day mean.
- No sparkline / mini-chart in the card. The user sees the *current*
  value but no story of how they got there.
- No "Δ vs last month" callout (the comparison toggle pattern shipped
  in v1.4.16 phase B8 lives only on the dashboard).
- No grouping. BD-Zielbereich (50 % in target) sits next to BMI
  (Normal) sits next to Einnahmetreue (64 %) — three completely
  different metrics styled identically.
- Status pills are passive — they label the current bucket but don't
  invite action ("So what do I do about this?").

The "ungelebt" feeling is real: every card is a flat reference card
with no momentum, no comparison, no "your trajectory" angle. It looks
like a guideline cheat-sheet, not a living health log.

### Three upgrade directions (pick one for Wave 4)

#### A) Sparkline-per-card + "Δ vs last month" callout

Each `<TargetCard>` grows a 30-day mini-sparkline beneath the range
bar (same `<HealthChart mini>` already used in the InlineCharts of
`/insights`). A second-line "Δ −2.3 kg vs last month" caption mirrors
the dashboard's comparison toggle so the user sees movement at a
glance. Status pill stays.

Pro: reuses existing components (HealthChart mini, comparison delta,
TrendCard's metric-sentiment colour rules). Each card becomes a
"current state + recent journey" block.

Con: doubles card height. 12 cards × +120 px is +1440 px scroll on
mobile. Need a "compact mode" toggle.

#### B) Status-row + drill-down — collapse cards into a scannable list

Replace the grid with a vertical list. Each row: icon + label +
current value + status pill + small trend arrow + chevron to expand.
Expansion reveals the range bar + 30-day chart + source link.

Pro: 12 metrics fit on one screen. Glance answer first, detail on
demand. Mirrors the iOS Health pattern users know.

Con: Bigger redesign — at-a-glance loses the range-bar visualisation
that gives the page its "where am I in the band?" answer. Might be
too clinical.

#### C) Storyline framing — a short headline + 3-target hero, then everything else

The page opens with a one-sentence summary "Du bist in 8 von 12
Zielbereichen.", then surfaces the 3 most-out-of-target metrics as
hero cards with bigger range bars + a "What changed?" callout, with
the remaining 9 collapsed below as a compact summary strip.

Pro: solves the "ungelebt" problem with a narrative. Targets become a
state-of-your-health page, not a reference book. The hero strip ties
back to the `<HeroStrip>` pattern shipped on `/insights` for visual
consistency.

Con: requires server-side ranking ("which targets are most out of
band?"), so this is a Phase-2 redesign. Out of scope for a polishing
marathon. **Defer to v1.5.**

### Recommendation: **A** (sparkline + Δ-vs-last-month)

Lowest effort, highest "the page now feels alive" payoff, reuses
existing components. The mobile-height cost is mitigated by collapsing
the range bar's surrounding meta into a single row. Direction B is a
v1.5-scope rethink; direction C is a v1.6 product call.

For Wave 4 the lift is roughly:

- Add `30dPoints?: number[]` to the `TargetData` API shape (server
  already has the data — `/api/insights/targets` reads from the same
  Prisma rows the dashboard does).
- Mount `<HealthChart types={[target.type]} mini />` inside
  `<TargetCard>` between the range bar and the classification row.
- Pipe the comparison delta from the existing `compare` server route
  (used by the dashboard) into the page query, render it as a
  `<TileCompareDelta>` row above the range bar.

## 5. v1.4.21 backlog inventory

Source: `.planning/v1421-backlog.md` (301 lines). Items grouped by
complexity bucket below.

### Quick wins (apply en masse in Wave 4 D — ≤5 lines diff each)

- **Sec-L-1** — `coachChatRequestSchema.conversationId` regex tightening to
  `^c[a-z0-9]{24}$` or `[A-Za-z0-9_-]{8,64}`. One-line schema change.
- **Sr-LOW-1** — drop redundant `@@index` on `coach_usage`; `@@unique`
  already builds it. One-line schema removal.
- **Code-MED-04** — reuse `buildWeightRangeFromHeight()` for
  `weightTrendAlignment`'s ±2 kg target band. Single import + call swap.
- **Code-MED-07** — drop the dead `confidence` prop from `<TrendsRow>`
  call site. One-line removal.
- **Design-L1** — drop the generic "personal-baseline" hero copy line.
  One-line removal.
- **Design-L5** — append `…` suffix when storyboard 24-char truncation
  fires. Three-line addition in
  `src/components/insights/storyboard-row.tsx`.
- **Design-L6** — replace German `Umschalt+Enter` with literal
  `Shift+Enter` to match the rest of the app. One i18n key change.
- **Code-LOW-01** — wrap `<HeroStrip>` greeting + relativetime in
  `useMemo`. Two-line change.
- **Code-MED-09** — wrap storyboard payload through
  `storyboardAnnotationsSchema.safeParse`. Pattern-copy from
  `dailyBriefing` lift; ~5 lines.
- **Sr-MED-1** — add 3 cascade-delete test rows for
  `coachConversation` / `coachMessage` / `coachUsage`. 5 lines.
- **Sr-LOW-4** — tighten `weeklyReport.weekISO` regex to validate
  weeks 01-53. One regex change.
- **S-06** — drop dead `historyRail` / `sourcesRail` / `composer` slot
  props on `<CoachDrawer>`. ~10 lines deletion.
- **S-07** — drop the never-overridden `inputId` prop on
  `<CoachInput>`. One-line removal.

**Wave-4 quick-wins count: 13 items**, total estimated diff ≤
~80 lines across 11 files. **Recommend folding all 13 into Wave-4 D.**

### Medium (one new helper / one component refactor)

- **Code-MED-02** — `bandFromInterval` "high" label on near-zero r —
  rename chip to "tight CI" / "wide CI" or demote when CI straddles
  zero. Touches the helper + every chip caller.
- **Code-MED-03** — Pearson p-value normal-approx error at low df.
  Either pull in incomplete-beta (~30 LOC) or raise df gate to 20.
  Decision call.
- **Code-MED-05** — `bpInTargetPct` "vs last week" delta is held
  constant. Recompute prior-snapshot rate or relabel the line.
- **Code-MED-06** — `WeeklyReportView` print spinner timer reset
  bug. Pin via ref.
- **Code-MED-08** — `provenanceFromJson` cast — validate against
  `WINDOW_KEYS` allow-list.
- **Code-LOW-03** — Promote nested `<Sheet>` portals on mobile rail
  trays to siblings.
- **Code-LOW-05** — add `bpInTargetRate` constant-test gap test.
- **Code-LOW-06** — `streamRefusal` budget meter accounting.
- **Sec-M-2** — call `checkRateLimit()` before refusal scanning OR
  bump `messageCount` inside `streamRefusal()`.
- **Sec-M-3** — extend `INJECTION_PATTERNS` with synonyms +
  zero-width strip pass. Maintenance pattern, ~30 LOC.
- **Sec-M-4** — wrap `appendMessage(assistant)` + `recordSpend()` in
  Prisma `$transaction`.
- **Sec-L-3** — skip `updatedAt` bump for refusal appends OR hide
  refusal-only conversations.
- **Sec-U-1** — Vitest case smoke-testing `request.clone()` against
  Next.js 16.
- **Sr-MED-2** — lift `weeklyReport` + `storyboardAnnotations` through
  `safeParse`.
- **Sr-MED-3** — wrap `handleChatRequest` in `enforceRateLimit()`.
- **Sr-MED-6** — offer `withIdempotency(handler, { skipWhen })` for
  conditional opt-out.
- **Sr-LOW-2** — migrate `metricSourceJson` from `String` to `Jsonb`.
- **Sr-LOW-3** — coach off-topic detector locale-mixed tightening.
- **S-08** — re-read `cloneForCheck` dead variable.
- **S-09** — compress health-score-card delta-arrow `&&` blocks into
  a `deltaIcon` lookup. Borderline.
- **Design-M1** — Hero strip greeting clock → Berlin via
  `Intl.DateTimeFormat`.
- **Design-M3** — Health Score panel mobile order inversion.
- **Design-M5** — Coach drawer focus trap — reparent rail-tray
  Portal container to SheetContent.
- **Design-M6** — Tone-bar visual clip at rounded corner.
- **Design-M8** — "n=N" reads as engineering output — use `{count}
  samples` / `{count} Werte`.
- **Design-L2** — Health Score sub-bars per-component band.

**Wave-4 medium count: 26 items.** Recommend Wave-4 picks the BP-tile
fix (Code-MED-05), the Sec-M-2/3/4 cluster (small but security-adjacent),
the `safeParse` lifts (Sr-MED-2 + Code-MED-08 + Code-MED-09), and the
2-3 design polishes that ride along (Design-M1 / M6 / M8). **Defer
the rest to v1.4.23.**

### Heavy (cross-cutting, schema, or larger refactor)

- **Sr-HIGH-2** — Consolidate Pearson + linear regression duplicated
  maths layer into `correlation.ts` + `regression.ts`. **v1.4.23**.
- **Sr-HIGH-4** — `<CoachDrawer key={prefill}>` weaponising React keys
  for state reset. Make `prefill` fully-controlled. **v1.4.23**.
- **Sr-MED-4** — Wire provider runner to true streaming with `onToken`
  callback. Unlocks "stop generating" as a real feature. **v1.5**.
- **Sr-MED-5** — `medication_schedules.days_of_week` schema drift.
  Either land the column with backfill or drop the field. **v1.4.23**
  (schema change with downstream impact).
- **Code-MED-01** — Streaming auto-scroll deps brittleness fix.
  Touches MessageThread effect and a new turn-counter hook.
  **v1.4.23**.

**Wave-4 heavy count: 5 items, all deferred.**

### Already obsolete (resolved en passant or no longer relevant)

- **Sec-U-2** — `enforceBudget` race window. Acceptable in practice;
  per-day cap. Annotation-only suggestion. Promote to "not a defect"
  and close.
- **Sr-MED-6** carry-over — `apiHandler`-vs-`withIdempotency` stacking
  is "largely moot now that the chat route doesn't wrap in
  idempotency". The carry-over note documents that — close as obsolete.
- The Docs-site MED + LOW items (versions stale, model count, schedule
  timezone, hashing wording) — these are cross-repo to
  `healthlog-docs`. **Out of scope for v1.4.22 HealthLog work**;
  belong in the docs repo's own next sweep. Move to a separate file
  `docs-followup.md` or close as out-of-repo.
- F5 README badges, FUNDING.yml, `.gitignore` audit, repo-root tidy —
  cosmetic only. The README badge add is useful but not v1.4.22-blocking.
  **Push to a hygiene PR**.
- `CLAUDE.md` / `AGENTS.md` filename rename, source-comment "Marc"
  sweep, DE+EN bilingual CHANGELOG normalisation — **defer to a
  hygiene PR series in v1.5**. The filename rename in particular is
  structural and would affect every IDE / CI tool that special-cases
  these filenames; a one-line v1.4.22 patch is the wrong vehicle.

**Obsolete count: 7 items.** Mark closed in the v1.4.21 backlog,
move docs items to `docs-followup.md`, and rebase v1.4.22 backlog
to start with the 13 quick-wins + 8-10 medium picks above.

---

## Summary numbers

- **Quick-wins to fold into Wave-4 D:** 13 items, ~80 LOC total
- **Medium picks to fold into Wave-4 (selectively):** 8-10 of 26
- **Heavy items deferred to v1.4.23 / v1.5:** 5
- **Obsolete to close:** 7

Probe artifacts:
- `/tmp/v1422-w1a/findings.json` + 4 viewport screenshots
- `/tmp/v1422-w1a-insights/findings.json` + 3 locale screenshots
- `/tmp/v1422-w1a-targets/desktop.png` + `pixel5.png`
