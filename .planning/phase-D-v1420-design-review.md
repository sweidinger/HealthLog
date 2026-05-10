# Phase D — Design / UX review (v1.4.20)

## Summary

- Surfaces audited: hero strip, daily briefing, suggested prompts, AI Coach drawer (drawer shell + body + composer + history rail + sources rail + message thread + source chips), correlation card + row, trends row + annotation, weekly report route, storyboard annotations on `<HealthChart>`, Health Score card.
- Findings: **0 CRITICAL · 4 HIGH · 9 MED · 6 LOW**
- Branch: `develop` @ `ded0b38` (B5 mounted in hero strip is the latest commit). The whole B-wave (B1 → B5) ships under v1.4.20.

---

## HIGH

### H1 — Coach drawer width busts the "1080 px" decision on common laptop screens
- Surface: AI Coach drawer · `src/components/insights/coach-panel/coach-drawer.tsx:137`
- What: The `<SheetContent>` is `w-full p-0 sm:max-w-[720px] lg:max-w-[1080px]`. On a 1280-px (most-popular laptop) viewport the drawer paints at 1080 px, leaving **only 200 px** of underlying `/insights` visible. On a 1366 px ThinkPad it's 286 px. The "keep dashboard context behind it" goal (file's own header comment) is unattainable below ~1440 px.
- Why: Either drop the cap to 920 px, or make it `lg:max-w-[min(1080px,calc(100vw-320px))]` so the dashboard always retains a readable column. Apple's HIG recommends the underlying content stay >= 320 px wide for sheet patterns. Today the drawer reads as a full-screen takeover on every laptop except 4K externals.
- Fix: switch the cap to `lg:max-w-[min(1080px,calc(100vw-360px))] xl:max-w-[1080px]` (or accept that the drawer is full-takeover and remove the multi-column body until xl).

### H2 — Touch targets on the suggested-prompt chips are 28 px tall — far under 36 px baseline
- Surface: Suggested prompts · `src/components/insights/suggested-prompts.tsx:74`
- What: chips are `px-3 py-1.5 text-xs`. The y-extent is ~28 px. Settings audit baseline (v1.4.16 phase B6) put the floor at 36 px on mobile, and Apple HIG / Material both call for 44 px. On a 375 px viewport the chip strip becomes a fingertip lottery.
- Why: This is the user's primary entry point into the new Coach. Mis-taps = drop-off.
- Fix: bump to `px-3.5 py-2 text-[13px]` (≈ 36 px). On `sm:` keep the smaller variant if vertical real-estate matters, but mobile must hit 36+.

### H3 — Streaming assistant text has no `aria-live` region
- Surface: Coach drawer message thread · `src/components/insights/coach-panel/message-thread.tsx:185-218`
- What: Assistant bubble updates in place as the SSE stream lands characters. There's no `aria-live="polite"` (or `role="log" aria-busy=...`) on the bubble or its container. Screen-reader users hear silence while sighted users see live text.
- Why: WCAG 2.1 SC 4.1.3 + the project's own pattern (`<DailyBriefing>` already uses `aria-live="polite"` for the loading label).
- Fix: wrap the streaming bubble in `<div role="log" aria-live="polite" aria-relevant="additions text">`. Reset the text on each new turn so SR users don't hear the previous reply re-read. Alternative: announce only the final reply (`aria-live="polite"` set after streaming completes).

### H4 — Sticky section-nav z-index conflict with the hero gradient on iOS
- Surface: `/insights` page · `src/app/insights/page.tsx:1715`
- What: `<InsightsSectionNav>` mounts at line 1000 with `sticky top-0 z-30`. It sits *below* the hero strip in DOM order, so on scroll it correctly slides up. But it carries `bg-background/80 backdrop-blur-sm` — and the hero's `glow-purple` shadow (`box-shadow … 0 18px 48px -28px`) bleeds **above** the nav while it's still above the fold. Once you scroll, the nav becomes a 40-px purple-tinted strip with a faint readability problem (purple shadow of the just-departed hero gradient still reflecting through the blur).
- Why: visual confusion on the most important navigation surface of the page.
- Fix: increase `bg-background/80` to `bg-background/95` (or `bg-card/95`) on the sticky nav, and clip the hero glow with `overflow-hidden` on the immediate parent (the hero already has `overflow-hidden` but the `box-shadow` paints outside the clip). Easiest: drop `glow-purple` for an inset shadow.

---

## MED

### M1 — Hero strip greeting clock is wall-clock, not Berlin
- Surface: hero strip · `src/components/insights/hero-strip.tsx:122-128, 163`
- What: `now ?? new Date()` reads the device's local time, then `.getHours()`. A user in Madrid logging in at 04:00 local sees "Good evening" — fine; but a user travelling who wants the Berlin time used for everything else in the app sees a different bucket from the rest of the UI. The CLAUDE.md says "Europe/Berlin for display".
- Fix: pass the current Berlin hour through (e.g. `Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", hour: "numeric" })` or use the existing `useFormatters` helper). Tests can keep the `now` override.

### M2 — German hero greeting buckets collapse 23:00–04:59 into "Guten Abend"
- Surface: hero strip · `src/components/insights/hero-strip.tsx:127`
- What: comment in `resolveGreetingKey` says "Night → Guten Abend so 03:00 doesn't read as Morgen". Fine; but the TWO buckets (`heroGreetingEvening` and `heroGreetingNight`) point to the same German string in `messages/de.json` (`Guten Abend`). That works but the duplicate key is dead weight.
- Fix: drop `heroGreetingNight`, fall through to `heroGreetingEvening` in the resolver.

### M3 — Health Score panel title-stack on mobile leaves 220 px score card below the prompt chips
- Surface: hero strip + health score · `src/components/insights/hero-strip.tsx:188-329`
- What: on `<lg` the order is greeting → subtitle → meta row → weekly banner → action row → prompt chips → **health score panel**. By the time the user scrolls to the score, they've already passed everything else. The score IS the headline metric — burying it last on mobile inverts the visual hierarchy.
- Fix: on `<lg` mount the Health Score panel between the meta row and the weekly banner (`order-2` Tailwind utility on the panel + `order-1/order-3` on siblings). Or render a compact "score chip" inline with the meta row on mobile and the full card only on `lg+`.

### M4 — Weekly-report eyebrow chip is uppercase with a `tracking-wide` — collides with the in-app rule of "sentence case"
- Surface: weekly report · `src/components/insights/weekly-report-view.tsx:163-169`
- What: `bg-dracula-purple/15 text-dracula-purple … uppercase tracking-wide` on the "Weekly report" tag. The CLAUDE.md user feedback (`feedback_marc_voice_english`) plus the v1.4.16 settings audit baseline both point at sentence-case for everything user-facing. The Coach rail labels use `uppercase` too (`coach-history-rail.tsx:96`, `sources-rail.tsx:79`, daily-briefing key-findings header) — pattern-wide.
- Why: micro-typography drift; reads like a marketing eyebrow rather than the calm-document tone the rest of HealthLog has.
- Fix: drop `uppercase` + `tracking-wide`, keep the `text-[11px]` to retain the rank.

### M5 — Coach drawer header has no visible focus trap when both rail trays are open
- Surface: Coach drawer · `src/components/insights/coach-panel/coach-drawer.tsx:235-274`
- What: the parent drawer is a Sheet (focus trapped by Radix). The two mobile rail trays at lines 235 + 259 are also Sheets, mounted **as siblings** of the parent SheetContent inside the same parent Sheet's content. Radix's portal pushes both onto the same z-50 layer; ESC handling is per-Sheet but Radix's focus-trap applies to the *outermost* trap. In practice on iOS Safari the focus can escape into the underlying `/insights` body once a tray is closed because the close-restore-focus target is set to `document.body`.
- Fix: render the rail trays as nested Sheets (i.e. children of the parent SheetContent — currently they are, but Radix's Portal lifts them above the parent). Either set `<Portal container=…>` to the parent SheetContent's ref, or use a `<Drawer>`-style stacked-modals primitive (`vaul` already in deps). At minimum, capture the rail-tray-trigger button refs and explicitly `triggerRef.current?.focus()` in the tray's `onCloseAutoFocus`.

### M6 — Daily Briefing tone-bar visually clips at the rounded card corner
- Surface: daily briefing · `src/components/insights/daily-briefing.tsx:93-99`
- What: tone-bar is `absolute top-3 bottom-3 left-0 w-[3px] rounded-r` over a card with `rounded-md`. The bar's vertical extent (`top-3 bottom-3`) inset cleanly, but the bar uses `rounded-r` (right side rounded), and it sits at `left-0` exactly on the card's outer rounded corner — the bar's left edge coincides with the card's rounded boundary, so the bar's straight left side pokes into the corner curve. Same shape on `correlation-card.tsx:89` (identical pattern).
- Fix: either inset by `left-1` / `top-2 bottom-2` to keep the bar inside the rounded corner, or add `overflow-hidden` to the parent card so the bar visually clips.

### M7 — "Try a 7-day experiment" CTA is a primary `variant="default"` Button — but disabled
- Surface: correlation card · `src/components/insights/correlation-card.tsx:138-150`
- What: the CTA paints in the primary purple (high contrast), but is `disabled` with a `title="Coming soon"`. Disabled-but-primary reads as "the system is broken right now" rather than "feature coming soon". Compare to the hero's "Generate weekly report" which uses the same disabled-default-button pattern at `hero-strip.tsx:246-257`.
- Fix: switch to `variant="outline"` while disabled; flip back to default when the feature ships. Or move it out of the card body into a footer link styled as `text-muted-foreground hover:text-foreground`. (Same recommendation for the hero "Generate weekly report" before B6 wires it.)

### M8 — Source chip pluralisation is "n=…" — locale-agnostic but reads as engineering output
- Surface: coach source chips · `src/components/insights/coach-panel/source-chips.tsx:89`
- What: chip renders `· n=12`. The German locale should read `· n=12` too (it's a math symbol), but the prefix character "n" plus the equals sign feels like raw stats output, not user-facing copy. The Trends row already does better (`based on {n} paired readings · {window}`).
- Fix: use `{count} samples` / `{count} Werte` or drop the count entirely on mobile and surface it in a tooltip on the chip.

### M9 — `disabled` settings cog button on Coach header has a tooltip but no visible affordance
- Surface: Coach drawer · `src/components/insights/coach-panel/coach-drawer.tsx:173-192`
- What: the gear icon stays full-opacity even while `disabled` (because `Button` only sets `disabled:opacity-50` from `buttonVariants`). Combined with `aria-label={t("insights.coach.settings")}` and the deferred-feature tooltip, screen-reader users get told "Coach settings" but the feature does nothing. Sighted users get a fully-styled icon with a "Coach settings arrive in v1.4.21" tooltip on hover.
- Fix: either drop the button entirely until v1.4.21 (the v1.4.16 settings audit playbook), or set `aria-label="Coach settings (coming in v1.4.21)"` so the SR experience matches the visual.

---

## LOW

### L1 — Hero "personal-baseline" copy reads as engineering: "Based on your last 90 days"
- `src/components/insights/hero-strip.tsx:215-217` — the meta-row label `t("insights.heroPersonalBaseline")` is the same line for every user, so it isn't really a baseline. Either drop it or surface the actual sample size ("From 187 readings over 90 days").

### L2 — `disabled` HealthScoreCard component sub-bars all paint at the score's band colour even when their sub-value is in a different band
- `src/components/insights/health-score-card.tsx:200-204` — every sub-bar uses `BAND_PROGRESS_CLASS[band]` (the **composite** band) for its fill. A user with a green composite score but a yellow weight component sees a green weight bar. Sub-bars should derive their own band per component for visual fidelity.

### L3 — Weekly report print stylesheet drops the eyebrow chip but keeps `bg-dracula-purple/15`
- `src/components/insights/weekly-report-view.tsx:165` — Tailwind `print:` utilities reset the wrapper's `bg-gradient-to-b` (line 161) but not the eyebrow chip's `bg-dracula-purple/15`. On a black-and-white printer the chip will print as a grey block. Add `print:bg-transparent print:px-0 print:text-foreground`.

### L4 — Source-chip "fresh" indicator uses a green-only static dot with no SR announcement difference
- `src/components/insights/coach-panel/sources-rail.tsx:103-106` — `aria-label={t("insights.coach.sourcesFresh")}` is hard-coded as "Fresh". The comment at line 16 acknowledges v1.4.21 will plug in real fresh/stale state. Until then, set `aria-hidden="true"` on the dot so SR users don't get told "Fresh" five times in a row.

### L5 — Storyboard annotation labels truncate to 24 chars on `<sm` but English copy can have a 25-char "Started Lisinopril 10mg dose"
- `src/components/charts/health-chart.tsx:1184-1187` — 24-char limit was chosen against the artboard's German labels which run wider; the truncation char itself isn't shown (`annotation.truncatedLabel` field). On a 375 px chart the label paints at the end with no ellipsis. Add `…` suffix when truncated.

### L6 — Coach composer placeholder leaks `…` (ellipsis) but the keyboard-hint uses `Shift+Enter` / `Umschalt+Enter` — locale-correct but inconsistent with the rest of the app
- `messages/{en,de}.json` `insights.coach.composerHint` — the rest of the app uses `Shift+Enter` even in German (`Umschalt` rarely surfaces on macOS keyboards). Marc's voice rule prefers the `Shift` literal. Reconsider the German translation.

---

## Things done particularly well

1. **Tone-bar pattern is consistent and load-bearing.** Daily briefing key-findings (good/watch/info) and correlation cards (per-hypothesis colour) both use the same `absolute top-3 bottom-3 left-0 w-[3px] rounded-r` recipe, with three Dracula tokens (`green/orange/cyan` for tone, `pink/cyan/purple` for hypothesis). The visual rhythm carries across the page without becoming a colour-zoo.
2. **Recharts defer-loading pattern is faithfully reused.** Every Recharts surface (correlation scatter, trends-row HealthChart + MoodChart) uses `next/dynamic` with a matching shimmer skeleton (`bg-muted/40 h-[180px] animate-pulse rounded-md motion-reduce:animate-none`). The `motion-reduce` guard is consistent end-to-end. This is the kind of disciplined defer-load I'd expect on a perf-audited bundle.
3. **Empty + loading states are first-class everywhere.** Every component surveyed (hero, briefing, correlation card, trend annotation, weekly report, history rail, message thread) ships an empty-state with a CTA AND a loading skeleton or spinner. The `<EmptyState variant="plain" size="compact">` reuse is excellent.
4. **Print stylesheet on the weekly report is a thoughtful Tailwind-only pattern.** Decoupling the print layout via `print:rounded-none print:border-0 print:p-0` on each `<Section>` (line 276) keeps everything in the React tree and avoids a separate `print.css`. Auto-print via `?print=1` deep-link from the hero banner is a nice touch that users actually want.

---

## Design decisions worth pushing back on

1. **Drawer-as-takeover at 1080 px on every laptop (H1).** The "keep dashboard context behind it" claim doesn't hold on the most-common laptop. Either commit to a takeover and remove the 3-column body until xl, or cap the width so the underlying page stays >= 360 px.
2. **Personal Health Score lives in the hero on `lg+`.** The score is HealthLog's strongest "Apple Health vibe" surface — burying it as a 220-px sidekick to a hero that's mostly action-row + prompts undersells it. Consider promoting the score to its own row directly under the hero on `>=md`, with the briefing card to its left/right. The artboard's BriefingHero composition supports this; the present implementation followed the prototype literally rather than letting the hierarchy drive layout.
3. **Disabled-primary buttons as feature placeholders.** The "Generate weekly report" hero button (still disabled in B6 even though B4 ships the route!) and the "Try a 7-day experiment" CTA both paint as primary purple. The user reads "this is broken right now" instead of "this is on the roadmap". Pattern is repeated 3x; worth a hygiene pass before v1.4.20 ships.
