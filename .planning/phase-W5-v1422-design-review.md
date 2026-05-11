# Wave 5 — Design / UX review (v1.4.22)

## Summary

- Surfaces audited: BP-in-target tile (`<TrendCard>` + `/insights` + `/dashboard`), insights row-fill rule + trends-row equal-height + correlation-row hide-on-insufficient-data, sticky `<InsightsSectionNav>` above the hero, "Muster → Zusammenhänge / Patterns → Relationships" rename, Coach drawer disclosures (`<details>` evidence block), Coach drawer header (avatar parity, settings cog removed, disclaimer relocated to sources rail), `/targets` per-card sparkline + Δ-vs-last-month, admin/api-tokens date cells, recommendation card chart-token strip, settings → dashboard global comparison toggle.
- Branch: `develop` (last shipped polish commit `1499e6f`); compared 25 v1.4.22 commits since `16b6976` (`main` merge).
- Findings: **0 CRITICAL · 3 HIGH · 7 MED · 5 LOW**

---

## HIGH

### H1 — `<InsightsSectionNav>` sticky bar is keyboard-hostile and lacks an accessible role

- Surface: `src/app/insights/page.tsx:1724-1773`
- What: The new section-tab strip is rendered as a flat `<nav>` with seven `<button>`s. The buttons (a) carry no `aria-current="location"` for the active tab — `IntersectionObserver` flips `activeId` purely visually, so screen-reader users get no readout that the active section changed; (b) carry no `:focus-visible` ring (`transition-colors` only animates the background — the focus ring is invisible against `bg-primary/10`); (c) every click triggers `el.scrollIntoView({ behavior: "smooth" })` unconditionally — `prefers-reduced-motion: reduce` users get a smooth scroll anyway. Combined effect on a keyboard or VO/JAWS pass: the user can tab through seven unlabelled "buttons", press one, and have no idea which section the page jumped to.
- Why: This is the page's primary navigation rail, lifted above the hero precisely so users see it first. The implementation reads as a glorified anchor list.
- Fix: (1) Switch to `<a href="#section-…">` with a click handler that calls `preventDefault()` + smooth-scroll only when `!matchMedia("(prefers-reduced-motion: reduce)").matches`. (2) Add `aria-current={activeId === id ? "location" : undefined}`. (3) Add `focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:ring-offset-2` to the per-button class. (4) Wrap the `<nav>` in `aria-label={t("insights.navAriaLabel")}` (English: "Skip to section", German: "Zu Abschnitt springen") so SR users hear the rail's purpose at landmark traversal.

### H2 — BP-in-Target tile shows three sub-rows in one flex on 280-375 px viewports

- Surface: `<TrendCard>` `src/components/charts/trend-card.tsx:258-326`
- What: After v1.4.22 A1/A2 the BP tile renders `7T: X% (+Δ)` · `30T: Y%` · `Allzeit: Z%` on the same `flex gap-3 text-xs` row. On 375 px (Pixel 5 / iPhone SE) the German strings — "7T: 78% (+5)" + "30T: 70%" + "Allzeit: 68%" — pack 38-42 chars into a sub-12 px font. On 280 px (Galaxy Fold compact) the row wraps three lines and the comparison-delta callout above it ("Δ +5 % vs. Vormonat") sits a second `text-xs` line up — the tile has **four stacked text rows** below the headline, and the BP tile is the densest of the trend cards by 2x.
- Why: The `compareBaseline !== "none"` branch was added in v1.4.16 B8 for every tile; v1.4.22 A1/A2 piled the all-time row on top without revisiting the mobile-density budget. The other tiles still have only two sub-rows (avg7 + avg30) so the BP tile reads "noisy" relative to peers.
- Fix options (pick one): (a) drop the `Allzeit` row when `compareBaseline !== "none"` — the comparison delta already speaks to the long-arc; (b) hide `Allzeit` on `<sm` viewports via a `hidden sm:inline` wrapper on the third `<span>`; (c) flatten on mobile to a single `flex flex-wrap gap-x-3 gap-y-0.5` so the three sub-rows live in a wrap rather than truncating.

### H3 — `<InsightsSectionNav>` z-index conflict with the hero glow + page padding cliff at 280 px

- Surface: `src/app/insights/page.tsx:1755`
- What: The nav is `sticky top-0 z-30 -mx-4 … md:-mx-6` on a parent that has the page's `space-y-8`. The negative margin is sized for the page-shell's `px-4` / `md:px-6`. On a 280 px Galaxy Fold the page renders inside `min-w-0` content; the `-mx-4` carries the nav past the safe horizontal-scroll boundary, and because the nav is `overflow-x-auto` itself, the fold viewport gets a ghost scrollbar at the bottom of the bar in addition to the actual horizontal-scroll affordance. (Same v1.4.20 H4 finding pattern: the bar's `bg-background/80 backdrop-blur-sm` is also too transparent — the hero gradient bleeds through during scroll.)
- Why: Pattern was lifted from the v1.4.20 page-internal nav at line 1715, never reconsidered when the strip was promoted above the hero. The double-scroll on Fold was never tested (e2e covers 375+).
- Fix: (a) bump opacity to `bg-background/95` to kill the bleed; (b) add `[scrollbar-width:none] [&::-webkit-scrollbar]:hidden` so the inner overflow doesn't paint a ghost bar; (c) change the negative margin to `-mx-[clamp(0.5rem,4vw,1rem)]` so the bar respects the page padding even at extreme small widths.

---

## MED

### M1 — Coach evidence disclosure has no `aria-controls` / `aria-expanded` semantics

- Surface: `src/components/insights/coach-panel/message-thread.tsx:259-307`
- What: The new "Worauf bezieht sich das?" / "What I'm looking at" disclosure uses native `<details>` + `<summary>` — that's the right primitive — but the chevron is a non-rotating `lucide-react` `<ChevronRight>` paired with `group-open:rotate-90`. Two issues: (1) the chevron is `aria-hidden` so VoiceOver can announce the summary text, but `<summary>` itself reports as a button without an "expanded" state in iOS Safari ≤ 17.3 (Webkit bug); the `<details>` is fine on all desktop browsers. The v1.5 iOS app will hit this bug. (2) The `marker:hidden` + `[&::-webkit-details-marker]:hidden` combo strips the native triangle but leaves the `<summary>` keyboard-focus ring at a 4px offset — visually it looks like the chevron has 4px of dead space on its left at focus. (3) The summary's hit target is `text-xs` line-height (~16 px) — under the 36 px floor.
- Fix: Wrap the summary's content in a 36-px-min hit zone via `min-h-9 -mx-1 px-1 py-1` so a finger tap reliably lands on the chevron. Keep the `<details>` primitive but add `aria-expanded` mirror via a tiny `useState` + `onToggle` to feed iOS-native screen readers.

### M2 — Sparkline on `/targets` has no min-points threshold guard for visual coherence

- Surface: `src/app/targets/page.tsx:264-303`, `:575-594`
- What: The page renders the sparkline whenever `points30d.length >= 2`. The Sparkline component itself returns null at `<2`; the API ships the field starting at >=3 points. But on a card with exactly 3-4 points spread over 30 days, the SVG paints a roughly horizontal trace that fills the full card width — it reads as "lots of activity" when really it's two flat segments. The path stroke uses `var(--dracula-purple)` (good — neutral, not status-coloured) but no fill gradient; the result on a card whose range bar above already shows a green/yellow/red marker is **a fourth element competing for the user's eye** (icon + value + range bar + sparkline).
- Why: The artboard's BriefingHero composition spec scoped the sparkline to "30 days = 30 points"; the API truncates to whatever the user logged, so a 4-point Withings-imported card has a totally different visual density to a daily-logged card. No empty-state.
- Fix: Either (a) require `length >= 7` before painting (one sparkline per week of data), or (b) render the trace with `stroke-opacity:0.5` for `length < 10` plus a `text-[10px] text-muted-foreground` caption "{n} of 30 days logged" so the user knows the trace's confidence.

### M3 — Recommendation card title uppercase severity badge re-introduces the "marketing eyebrow" pattern v1.4.20 M4 flagged

- Surface: `src/components/insights/recommendation-card.tsx:328-335`
- What: After v1.4.22 stripped `metric:<TYPE>` tokens from prose (good!), the `<Badge>` for severity still renders as `text-[10px] tracking-wide uppercase` displaying the literal `info` / `suggestion` / `important` / `urgent` token (e.g. "URGENT"). v1.4.20 M4 specifically called out uppercase eyebrows as breaking sentence-case consistency; the recommendation card carries five of those eyebrows in a typical "12-rec" advisor payload. Plus, the badge text is the **internal severity enum** ("urgent", "suggestion") — these should route through `t(\`insights.recommendation.severity.\${norm.severity}\`)` so German users see "Dringend" / "Vorschlag" instead of the English token.
- Fix: Drop `tracking-wide uppercase`, replace `{norm.severity}` with `{t(\`insights.recommendation.severity.\${norm.severity}\`)}`. Add the four DE/EN keys.

### M4 — Coach disclaimer relocated to sources rail is invisible when the rail is hidden on `<lg`

- Surface: `src/components/insights/coach-panel/sources-rail.tsx:283-294`, `coach-drawer-body.tsx:106-110`
- What: v1.4.22 B4 moved the disclaimer ("Coach replies are generated. Clinical decisions belong with your doctor.") into the sources-rail footer. On the desktop layout (`xl+`) the rail sits in the right column and the disclaimer is always visible. On `lg` (1024-1279 px) and `<lg` (every laptop and every mobile), the sources rail is **only reachable via the chevron-tray** — the disclaimer never paints unless the user actively opens the tray. That regression dropped the medical-disclaimer reach from "every Coach session" to "the subset of users who tap a chevron". Material risk if a clinician audit reads the Coach without seeing the disclaimer.
- Fix: Either (a) keep the disclaimer in its old composer slot too (tiny, single line under the input) OR (b) render it inline above the composer on `<xl` viewports as `text-[10px] text-muted-foreground border-t pt-2`. The B4 plan was sensible visually but the medical-safety angle outweighs the visual quiet.

### M5 — `/insights` row-fill rule on the medication-correlation row relies on `showMoodSection` heuristic

- Surface: `src/app/insights/page.tsx:1070-1078`
- What: The row-fill rule is `showMoodSection ? "grid gap-4 xl:grid-cols-2" : "grid gap-4"`. That works for the mood gate, but the **right card** can also be insufficient-data (n<5) while the mood section is otherwise visible. Result on a fresh tenant: BP-medication card carries the empty state (Activity icon + "Not enough data") in a half-width column with the mood-vs-BP card paint going to 100 % — the layout reads "two half-cards, one full" and the user has no idea why the right card moved. The v1.4.22 A4 commit hid empty _correlation-row_ tiles; this row's per-card empty state stayed.
- Fix: Either (a) hide the BP-medication card entirely when `bpMedicationScatterData.length < 5` and let mood-vs-BP take 100 %, OR (b) keep the fixed 50/50 layout and let both cards carry their per-card empty state (current v1.4.21 behaviour). Inconsistency between the trends-row hide-on-insufficient and this row's keep-empty-state pattern will read as "one of these is broken".

### M6 — Settings → Dashboard global comparison toggle has no live preview / "Try it" affordance

- Surface: `src/components/settings/dashboard-layout-section.tsx:204-241`
- What: The picker is a plain `<Select>` with three options + a hint paragraph. The picker is now the **only thing between the H1 and the widget table** (per the inline comment at line 184 — the redundant help line was removed). Saving the toggle flushes the value to the server which is then read by every chart + tile on the dashboard / insights / targets pages on next render. There's no way for the user to see what "Compare with last month" looks like before saving — the user has to save, navigate to `/`, see the change, navigate back, save the previous setting. The v1.4.16 B8 implementation accepted this because the picker lived inside a per-tile drawer; the v1.4.22 lift to a global setting widens the cost of a wrong choice.
- Fix: Add a tiny `<TrendCard>` preview swatch under the picker that re-renders on value change, OR bake an inline mini-chart that shows "this is what the comparison overlay looks like". The Dracula token consistency stays intact (use the existing TrendCard primitive).

### M7 — Sparkline aria-hidden hides the only signal of trend on mobile

- Surface: `src/app/targets/page.tsx:286-301`
- What: The SVG is `aria-hidden="true"` so screen-reader users skip it entirely — fine — but the sparkline is the only "are things changing?" affordance on the card aside from the `<TrendIcon>` (up/down/stable) at the top right. The trend icon is also `lucide-react` icons with no `aria-label`. Result: a VO user gets the value, the unit, the average, the range bar (status badge text), and the delta caption; the **direction of change** is implicit only from the delta sign. That's a regression compared to v1.4.21 where the trend icon was the only "direction" surface but at least carried a status icon.
- Fix: Either (a) keep the SVG `aria-hidden` but add `aria-label={target.trend === "up" ? t("targets.ariaTrendingUp") : …}` to the `<TrendIcon>` parent, OR (b) make the delta caption do the lifting: change "+5 vs. Vormonat" to "+5, slightly higher vs. last month" so the sentiment is in the prose, not just the colour.

---

## LOW

### L1 — "Worauf bezieht sich das?" / "What I'm looking at" disclosure title is asymmetric in voice

- `messages/en.json:874`, `messages/de.json:874`. The German question form ("Worauf bezieht sich das?") is curious + first-person; the English ("What I'm looking at") is declarative + first-person-singular. Both work in isolation but a bilingual user toggling locales will notice the voice shift. Consider either "Was schaut der Coach an?" / "What the coach looked at" (declarative, third-person) or "Worauf basiert das?" / "What's this based on?" (curious, declarative).

### L2 — Coach evidence rows render the LLM-emitted `kv.label` verbatim with no key stability

- `src/components/insights/coach-panel/message-thread.tsx:286-304`. The `<li key={\`\${kv.label}-\${idx}\`}>`allows duplicate labels (e.g. two "Average BP" entries for last 7 vs. last 30) to collide on a stable React key when the index is the same across renders. With the planned conversation-pagination this won't matter, but as soon as the message list incrementally grows, a duplicate-label key warning will surface in dev. Use`kv.id`if the schema has one, or hash`\${kv.label}-\${kv.window}-\${kv.value}`.

### L3 — Targets sparkline sets `preserveAspectRatio="none"` which distorts the line at extreme aspect ratios

- `src/app/targets/page.tsx:288`. With `preserveAspectRatio="none"` and the SVG container `h-6 w-full` (24px tall, ~280-440px wide), the X-axis is stretched 12-18× the Y-axis. A 0.5 kg movement over 30 days reads visually identical to a 5 kg movement because the Y range is auto-scaled to the data and stretched to fit. Consider a fixed Y-range pegged to the target range so the trace reads relative to "in target" / "out of target". Alternative: keep `preserveAspectRatio="xMidYMid meet"` and accept that some trace might not fill the full height.

### L4 — `/insights` page padding for `<InsightsSectionNav>` `scroll-mt-28` is hard-coded

- `src/app/insights/page.tsx:1020,1044,1258,1428,1463,1491,1592` all carry `scroll-mt-28` (~7rem = 112px). The sticky nav itself is ~40-44 px tall (py-2 + text-xs + a `border-b`). The 112-px scroll margin is ~2.5x the nav height, so when the user clicks "Pulse" the heading lands well below the top of the viewport with a noticeable gap. Either reduce to `scroll-mt-16` (64 px ≈ nav + breathing room) or document the rationale ("makes room for the hero re-anchor on smooth-scroll").

### L5 — Admin API tokens date cells now wrap to two lines on 1024 px viewports

- `src/components/admin/api-token-overview-section.tsx:243-250` (the v1.4.22 C2 fix). The 12 % `<col>` width allotment for the two date columns is ~84 px on a 700-px content area. `formatDateTime` produces "05.05.2026, 21:46" (~110 px). Dropping `whitespace-nowrap` lets the cell wrap to two lines — fine on a desktop with vertical real-estate, but the row now alternates between one-line and two-line heights based on whether each row's date wrapped, giving the table a "bumpy" rhythm. Easiest fix: use the short date format `formatDate` (no time) for the table and surface the precise stamp in a hover tooltip. Or push the `<col>` width to 14 % so the date fits on one line for German formatting.

---

## Things done particularly well

1. **Recommendation prose is finally clean.** Stripping `metric:<TYPE>` tokens out of the visible prose (and keeping the parse-side regex permissive enough to catch lowercase / snake_case hallucinations like `metric:blood_pressure_sweet_spot`) is the single biggest copy-quality win in v1.4.22. The split between strip-side and parse-side regex (`STRIP_TOKEN_REGEX` permissive, `PARSE_TOKEN_REGEX` strict) is the right shape — it kills leaks in the rendered DOM while still letting the renderer drop unrenderable tokens silently. Strong defensive design.

2. **BP tile architecture is cleaner than the comment suggests.** The "synthetic slope from 7d-vs-30d" trick (`page.tsx:822-837`) is a tidy way to give the BP tile feature parity with the other tiles without cooking up a dedicated trend pipeline. The pinned-to-1 confidence (line 836) prevents a downstream `R²==0` consumer from mis-treating it as low confidence — that's the kind of "land-mine the next contributor" annotation the codebase appreciates.

3. **Empty-state collapse on the correlation row + trends row is a calm UX pattern.** v1.4.22 A4's switch from "render an empty placeholder card" to "drop the card entirely and let the row collapse to 1-up / 100 %" gives the page a much calmer rhythm on a fresh tenant — no greyed-out half-rows screaming "you don't have enough data". The trends-row equal-height min-h-[300px] flex-col composition (lines 105-155 of trends-row.tsx) is the kind of layout discipline that pays off for the entire v1.5 surface.

---

## Design decisions worth pushing back on

1. **Sticky section nav above the hero (A5) competes with the hero for first-paint attention.** The strip is the first focusable element on `/insights` post-A5; the user's eye now has to choose between (a) the dense seven-tab strip and (b) the hero gradient + greeting + score panel. The artboard had the section nav inline below the hero specifically so the hero could land first. Pushing the strip above the hero gives every visit to `/insights` a "control panel" feel rather than a "your morning briefing" feel. Reconsider whether the v1.4.20 inline placement (just above the per-section content) was the right call after all; the v1.4.22 lift was a velocity-driven move, not a UX-tested one.

2. **Coach disclaimer relocation to the sources rail (B4).** The principle is right — keep the composer focused on the input affordance — but the execution dropped the disclaimer's reach from 100 % of Coach sessions to ~xl-only. Either keep both (composer + rail) or rethink the relocation. The medical-safety surface in HealthLog is one of the differentiators the user mentions in `feedback_ai_insights_differentiator`; quietly hiding the disclaimer behind a chevron erodes that differentiator.

3. **Settings cog removal (B5).** Agreed in principle (the v1.4.20 cog had no real wiring and the placeholder tooltip read as dead UI), but the comment ("A real settings surface for per-user prompt-tuning lands with v1.4.23") implies a return is planned. Consider whether the right replacement is _not_ a cog: per-message "thinking style" controls or a one-time onboarding ("How chatty should the Coach be?") would be more useful than a global preference panel that 95 % of users never open. This is a "design in v1.4.23" punt, not a v1.4.22 finding — flagging here so the next iteration doesn't reflexively re-add the cog.
