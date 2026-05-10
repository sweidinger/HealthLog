# Phase D — DESIGN/UX review (v1.4.16, Apple-Health-quality benchmarking lens)

Reviewer: phase-D DESIGN/UX agent
Marathon: v1.4.16 (live: 1.4.15; under-test: 1.4.16)
Date: 2026-05-09 (UTC+2)
Approach: source-code audit (v1.4.16 not yet deployed; live Playwright not driven).

Per brief: "Apple Health benchmarking lens — does the polish reach the bar Marc set?"

---

## Executive summary

v1.4.16 ships a *huge* amount of code-level polish (gradient hero, ConfidenceMeter, RationaleCard with mini-charts, severity-coloured grid, comparison overlay, host-load chart, AI quality table). However, the **headline finding** is that the most visible Apple-Health-quality affordances — the polished `<InsightAdvisorCard>` consuming `<RecommendationsGrid>`, `<RecommendationCard>`, `<ConfidenceMeter>`, `<RecommendationFeedback>` — are **NOT mounted on any production page**. They live in tests only.

The v1.4.16 release as Marc would experience it on `/insights` is the same v1.4.15 text-only `<InsightStatusCard>` per section. The dashboard `/` likewise does not import `<InsightsCardPreview>`. **All of B5c, B5d, B5e, and B1b's cross-feature polish is invisible to the user.** This is the single biggest disconnect between the work that landed and the user's perception of the release.

A second category: the comparison toggle (B8) is *only* reachable from `/settings/dashboard-layout`. There is no on-chart, on-tile, or on-page control on `/` or `/insights`. The brief was explicit ("Mobile-friendly comparison toggle, not a fragile hover-only interaction") and the UX cost is severe: a v1.4.16 user has zero on-surface affordance to toggle Vormonat / Vorjahr.

Findings below grouped by severity.

---

## CRITICAL — ship-blockers for v1.4.16 (must fix before tag)

### C1 — `/insights` does NOT mount the polished `<InsightAdvisorCard>` / `<RecommendationsGrid>`. B5c/d/e/B1b are invisible

- **File:** `src/app/insights/page.tsx:1006-1539`
- **Issue:** every insights section renders `<InsightStatusCard>` (text-only summary, no rec card, no rationale, no confidence meter, no thumbs-feedback). The Apple-Health-style polish from B1b (`<InsightsPageHero>` is mounted, but it's just a header band) and the entire B5c/d/e rec-card surface (`<RecommendationCard>`, `<ConfidenceMeter>`, `<RecommendationFeedback>`, `<RationaleCard>`) is never reachable from any live route. Confirmed via `grep "InsightAdvisorCard"` — zero non-test imports across `src/`.
- **Recommendation:** wire `<InsightAdvisorCard>` into `/insights` (consume `/api/insights/generate`) **or** explicitly de-scope B5c/B5d/B5e/B1b from v1.4.16 release notes and tell Marc the visual polish ships in v1.4.17. The B5c/d/e reports each flag this gap ("E2E not added — not mounted on a live route") but none actually wire the card. Without wiring, Marc gets v1.4.15 UX with extra unused code paths.
- **Ship-blocker?** YES.

### C2 — `<InsightsCardPreview>` (dashboard insights tile) has zero live imports — orphan component

- **File:** `src/components/insights/insights-card.tsx:49`; `src/app/page.tsx` (no import)
- **Issue:** B1b commit 5 (`d2cdf9d`) replaced the orphan v1.4.0 `<InsightsCard>` with a polished preview that renders top severity-ordered recs + ring-variant `<ConfidenceMeter>` inline. The dashboard never imports it. `grep "InsightsCardPreview" src/app` — zero matches. The dashboard renders `RecentAchievementsCard` + tile strip + charts, no insights preview.
- **Recommendation:** mount `<InsightsCardPreview>` on `/` (the B1b report flagged this as "When dashboard wiring lands…") or hide the file and remove from v1.4.16 marketing claims.
- **Ship-blocker?** YES — Marc sees no insights tile on the dashboard despite the B1b report explicitly citing dashboard polish.

### C3 — Comparison toggle (B8) has NO on-surface control. Buried 3 clicks deep in Settings

- **File:** `src/components/settings/dashboard-layout-section.tsx:192-198` (only place `compareBaseline` is settable)
- **Issue:** Marc must navigate to /settings/dashboard-layout, scroll past 14 widgets, find the "Comparison Baseline" Select, change it, save, then back-navigate to / or /insights. The brief explicitly required "Mobile-friendly comparison toggle (not a fragile hover-only interaction)" — what shipped is a Settings-Save round-trip every time the user wants to flip from "vs. last month" to "vs. last year" or back to off. The B8 report's deferred-list mentions a `<CompareToggle>` segmented control was scoped but never built; only the persistence layer + chart-side rendering exist.
- **Recommendation:** add a `<CompareToggle>` (segmented "None / Vormonat / Vorjahr") next to the existing range tabs (7d/30d/90d/All) on each chart, OR a single page-level toggle pinned next to the dashboard greeting. Persists via the same `dashboardWidgets` PUT the settings page uses, no API change. Without it, the comparison-overlay code (compareBaseline plumbed through 19 chart sites + tile-strip + `comparison.deltaVs.*` i18n) is dead UX — admins can demo it, users can't find it.
- **Ship-blocker?** YES — major B8 deliverable is invisible without an on-surface toggle.

---

## HIGH — fix in v1.4.16 if cycle allows, or document for v1.4.17

### H1 — Recommendation feedback thumbs are 28×28 px hit-area — fails WCAG 2.5.5 (44 px floor)

- **File:** `src/components/insights/recommendation-feedback.tsx:268, 283`
- **Issue:** both thumb buttons use `inline-flex h-7 w-7 items-center justify-center rounded-md`. h-7 = 28 px. WCAG 2.5.5 minimum is 44×44 CSS px. Wave-C MED bottom-nav fix was specifically about 44 px floors; the same floor must apply to per-rec feedback that Marc taps on a Pixel 5. Also: zero `focus-visible:` styles on the raw `<button>` so keyboard focus is invisible.
- **Recommendation:** swap to `min-h-11 min-w-11` (or `min-h-9` at minimum + extra padding around an inner icon), add `focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2`. The brief asks "thumbs feedback button hit-area large enough" and the answer today is no.
- **Ship-blocker?** Borderline — Marc said 44×44 is the floor; any consumer accessibility audit will cite this.

### H2 — Recommendation card chevron expand toggle: 24×24 hit area, no focus-visible

- **File:** `src/components/insights/recommendation-card.tsx:368-385`
- **Issue:** raw `<button type="button" className="text-muted-foreground hover:text-foreground rounded-md p-1 transition-colors">` with a `<ChevronDown className="h-4 w-4">` inside. p-1 (= 4 px) + h-4 (= 16 px) gives ~24×24. Brief: "expand affordance discoverable; confidence meter readable; thumbs feedback button hit-area large enough." Current chevron fails the same 44 px bar as H1.
- **Recommendation:** wrap in `<Button variant="ghost" size="icon" className="h-9 w-9">` or hand-bump to `min-h-11 min-w-11`. Add `focus-visible:` ring (raw `<button>` has none).
- **Ship-blocker?** Same answer as H1. If H1 ships, H2 must too; feels broken if only one is fixed.

### H3 — Trend-card aria-label hardcoded English (i18n leak)

- **File:** `src/components/charts/trend-card.tsx:229-233`
- **Issue:** the comparison delta `aria-label` interpolates `"vs. last month"` / `"vs. last year"` as **literal English strings** regardless of the user's locale. Marc switching to DE gets a screen-reader announcing English while the visible text is German ("Δ −2.3 kg vs. Vormonat"). All other labels in the file use `t(...)`. Undocumented bypass.
- **Recommendation:** use the same `t(comparison.captionLastMonth/Year)` key the visible text consumes two lines below.
- **Ship-blocker?** No, but trivial fix.

### H4 — Medication-Compliance chart does NOT support `compareBaseline` overlay. Inconsistent with all other charts

- **File:** `src/components/charts/medication-compliance-chart.tsx`
- **Issue:** `grep "compareBaseline" medication-compliance-chart.tsx` — no prop. Every other chart family (BP/weight/pulse/mood) accepts `compareBaseline` and renders the dimmed prior-period line. The medication-compliance heatmap doesn't, so when the user toggles Vormonat the rest of the dashboard responds and only this card stays static. Not strictly a regression (B8 report flags compliance heatmap "doesn't shrink cleanly" and was deferred for the rec-card mini-mode), but the *toggle* still needs to be honoured visually somehow.
- **Recommendation:** add a one-line caption "Vergleich nicht verfügbar für Compliance" / "Comparison N/A for compliance" so the user understands the asymmetry rather than thinking the toggle is broken.
- **Ship-blocker?** No, but UX-incoherent without a fix.

### H5 — `via-dracula-cyan/8` Tailwind class — opacity `/8` is technically valid but visually nearly identical to bg; gradient appears flat on mobile

- **File:** `src/components/insights/insights-page-hero.tsx:81`
- **Issue:** `from-dracula-purple/15 via-dracula-cyan/8` — the via-stop at 8% opacity over a Dracula `--background` (#282a36) is a ΔL of ~3% from the page bg. On a Pixel 5 LCD in daylight, this looks like a flat purple band with no gradient. Apple Health hero gradients use 25-40% opacity at the brightest stop.
- **Recommendation:** bump to `from-dracula-purple/25 via-dracula-cyan/15` (commit 6 already raised opacity once; raise again or use inline CSS gradient where Tailwind's discrete steps clip the design).
- **Ship-blocker?** No, but the "Apple-Health-quality benchmarking" bar is what Marc set; this gradient does not meet it.

### H6 — Range-tabs (chart 7d/30d/90d/All) hit-area `min-h-9 px-2.5` = 36×~28 px. Below 44 px on Pixel 5

- **File:** `src/components/charts/health-chart.tsx:882`
- **Issue:** `className="min-h-9 px-2.5 text-xs"`. On the Pixel 5 viewport the user taps four narrow pills above each chart; missed-taps are routine. WCAG 2.5.5 again.
- **Recommendation:** swap to `min-h-11 px-3` or use a Radix `<Tabs>` primitive with a `min-h-[44px]` modifier (same as bottom-nav).
- **Ship-blocker?** No, but the brief calls out 44×44 explicitly.

### H7 — Medication CSV "include intake history" uses raw `<input type="checkbox">` 16×16 px. Mobile fail + visual inconsistency

- **File:** `src/components/settings/export-section.tsx:457-466`
- **Issue:** every other settings toggle is a `<Switch>` from `@/components/ui/switch`. The intake-history toggle is a vanilla `<input type="checkbox" className="border-border h-4 w-4">`. 16×16 hit area, breaks design-system consistency, and on iOS Safari renders as the system blue checkbox (jarring against Dracula).
- **Recommendation:** replace with `<Switch>` or shadcn `<Checkbox>`. Bump container to `<label className="flex min-h-11 …">`.
- **Ship-blocker?** No, but Marc's eye will catch the system-blue box on his iPhone immediately.

### H8 — DE fallback-chain row will overflow Pixel 5 (393 px) — 5 controls per row, all with German labels

- **File:** `src/components/settings/ai-section.tsx:1374-1434`
- **Issue:** each chain row is a `flex flex-wrap` with 5 controls (label hyperlink + Switch + ArrowUp + ArrowDown + X). EN labels are short (Move up / Move down / Remove from chain) but DE strings are longer ("Nach oben", "Nach unten", "Aus Kette entfernen") and the row uses `gap-2` so on 393 px it wraps to 2-3 lines per row. A 5-row chain becomes ~12 visual lines.
- **Recommendation:** at `<sm` breakpoint, hide aria-only textual labels on arrow buttons (icon is universal) and collapse the X into a long-press or "more" overflow menu. Or shrink each row to provider name + switch + drag handle, with reorder via popover.
- **Ship-blocker?** No, but renders unusably on Pixel 5 mobile in DE locale.

---

## MED / LOW — polish, parity, post-v1.4.16 cleanup

### M1 — App-log preview table uses `overflow-x-auto` with no mobile card fallback

- **File:** `src/components/admin/app-log-preview-section.tsx:207-263`
- **Issue:** B4 admin app-logs renders `<table>` inside `overflow-x-auto`. On Pixel 5 (393 px), 5 columns (level / timestamp / action / duration / trace_id) → user scrolls horizontally. A3 fix already swapped api-tokens to a card-list mobile fallback.
- **Recommendation:** add card-list rendering at `<md`. Mirror `<UserManagementSection>` pattern.

### M2 — RecommendationFeedback success state replaces row with text-only "Thanks" — no path to revoke or change verdict

- **File:** `src/components/insights/recommendation-feedback.tsx:212-225`
- **Issue:** once submitted, the row collapses to one line of text + check icon. There's no UI path to revoke or change the verdict. Server-side dedup is by `(user, recId, recText)` so a new attempt would 409, but the client-side UX gives no hint that this is final.
- **Recommendation:** keep the chosen thumb visible (highlighted / pressed-state) and add a quiet "Submitted — undo?" affordance. Even if not actually re-submittable, give the user the visual receipt of which thumb they chose. Apple Health's tendency: never collapse a state without an undo path.

### M3 — `<RecommendationsGrid>` border colors at `/70` opacity — not contrast-verified against `--card`

- **File:** `src/components/insights/recommendations-grid.tsx:64-69`
- **Issue:** `border-l-dracula-red/70` etc. The B1b commit-6 added a contrast-regression test for the page hero but not for the grid borders. At 70% opacity over `--card` (which is `--dracula-bg` slightly tinted), red border ratio is ~3.8:1 (passes 3:1 UI floor); purple is closer to 2.6:1 (likely fails). Severity is information-bearing.
- **Recommendation:** measure each token at `/70` against `--card`; bump under-3:1 ones to `/85`.

### M4 — ConfidenceMeter aria-label says "Vertrauen 75 von 100" — no band semantic

- **File:** `src/components/insights/confidence-meter.tsx:189-191`
- **Issue:** screen-reader announces only the raw integer. Better signal: "high confidence (75/100)" / "medium" / "low" / "draft". Apple's accessibility lead would call out the missing band — the visual ring color is the primary signal but blind users only get the number.
- **Recommendation:** include the band name in aria-label. New i18n key `confidenceAriaWithBand` taking `{value, band}` placeholders.

### M5 — InsightsPageHero hides "Generated" timestamp when no insight has been generated, but the hero band stays full-height — looks empty on first visit

- **File:** `src/components/insights/insights-page-hero.tsx:106-120`
- **Issue:** when `updatedAt` is null, the meta row collapses to a single "Based on your last 90 days" line. Hero remains visually heavy with no content density delta. First-time users see a giant gradient with two short text lines.
- **Recommendation:** when `updatedAt === null`, surface a "Generate your first insight →" inline CTA in the meta row. The regenerate button is already passed in via `onRegenerate` but appears top-right; promoting to inline-with-meta CTA would close the empty-state hole.

### M6 — Inconsistent severity color tokens between `<HeroFinding>`, `<RecommendationCard>`, `<RecommendationsGrid>`

- **Files:** `src/components/insights/insight-advisor-card.tsx:103-131` (HERO_STYLES) vs `src/components/insights/recommendation-card.tsx:49-56` (SEVERITY_BADGE_STYLES) vs `src/components/insights/recommendations-grid.tsx:64-69` (SEVERITY_BORDER_CLASSES).
- **Issue:** three separate style maps for the same severity vocabulary. Hero uses `green/cyan/orange/red` (assessment); rec-card uses `cyan/purple/orange/red` (severity); grid uses `red/orange/purple/cyan` (also reversed mental model). The hero & rec-card maps disagree about what "info" means (cyan in both, but the hero's "neutral assessment" is also cyan).
- **Recommendation:** centralise to `src/lib/severity-colors.ts`, expose helpers, have all three components consume them. v1.4.17 simplify-target.

### M7 — Sticky `<InsightsSectionNav>` + iOS Safari back-swipe gesture interference

- **File:** `src/app/insights/page.tsx:1695-1713`
- **Issue:** `flex gap-2` inside `overflow-x-auto`. On iOS Safari the back-swipe gesture competes with horizontal pan inside the sticky nav.
- **Recommendation:** add `overscroll-x-contain`.

### M8 — Host-metrics chart tooltip uses `formatter(value, name)` matching against `t(...)` outputs — i18n-fragile

- **File:** `src/components/admin/host-metrics-chart.tsx:278-298`
- **Issue:** `if (name === t("admin.hostMetrics.load1"))` — relies on string equality between Recharts' `name` prop and the localised label. If user mid-session swaps locale, formatter falls through and tooltip shows raw numbers without unit.
- **Recommendation:** key the formatter on a stable dataKey, not the localised name.

### M9 — Mood chart emoji glyphs (😖 🙁 😐 🙂 😄) — non-localizable, render differently per OS

- **File:** `src/components/charts/mood-chart.tsx` (B1a deliverable)
- **Issue:** emoji rendering varies between Apple, Noto Color Emoji, Segoe UI Emoji. Marc's iPhone vs Pixel 5 vs desktop Mac = three different visual weights for the same chart.
- **Recommendation:** v1.4.17 — replace emoji with custom SVGs (lucide has `Frown / Smile / Meh / Laugh / SmilePlus` that close the gap).

### M10 — `RecommendationCard` collapsed state has no visual hint that it's interactive

- **File:** `src/components/insights/recommendation-card.tsx:331-417`
- **Issue:** the chevron is the only affordance; the card border is identical for collapsed and expanded recs. Apple Health uses a subtle "tap to expand" caption + 1-px depth shadow. Oura's Contributors use a small "i" subtitle "Tap to see why". HealthLog: nothing.
- **Recommendation:** add `text-muted-foreground/60 text-[10px]` hint under rec text "Tap for details" / "Antippen für Details" on the collapsed state. Auto-disappears when expanded. Trivial; very high-leverage on first impression.

### M11 — Loading skeleton uses staggered `animationDelay` unconditionally — reduced-motion users still see staggered placeholders

- **File:** `src/components/insights/insight-advisor-card.tsx:340-348`
- **Issue:** `style={{ animationDelay: \`${i * 100}ms\` }}` is unconditional. With `prefers-reduced-motion: reduce`, the underlying `animate-pulse` is killed but the placeholders still appear in staggered fashion when their (already-stopped) animation would have fired.
- **Recommendation:** check `prefersReducedMotion()` in the JSX and skip the inline `animationDelay` when true.

### M12 — Insights page first-load: bare `Loader2` spinner, no skeleton shell mirroring final layout

- **File:** `src/app/insights/page.tsx:851-857`
- **Issue:** when `isLoading`, the page renders a centered spinner — no structure on first paint. Apple Health renders cached data immediately + spinner overlay; HealthLog could render `<InsightsPageHero updatedAt={null} />` + tile-strip skeleton + section-nav skeleton during the 2-second slow-API window.
- **Recommendation:** mount hero + skeleton tile strip during `isLoading` so the page has structure on first paint.

### M13 — `app-logs` empty state doesn't distinguish "buffer empty" from "filter matched nothing"

- **File:** `src/components/admin/app-log-preview-section.tsx:200-205`
- **Issue:** the EmptyState renders the same `admin.section.app-logs.empty` copy whether the buffer is genuinely empty (fresh process) or filters narrowed to zero. No CTA to clear filter.
- **Recommendation:** branch on `(traceId || actionFilter || level !== "__all__" || range !== "all")` to emit a "No matches — clear filters?" variant with reset button.

### M14 — Settings → Export `<input type="date">` is browser-locale-driven, not app-locale-driven

- **File:** `src/components/settings/export-section.tsx:248-284`
- **Issue:** `<Input type="date">` renders MM/DD/YYYY on US-locale browser even when app locale is DE. iOS opens a wheel picker (44 px) which is OK but the calendar icon overlaps long DE month names.
- **Recommendation:** v1.4.17 — wrap with `react-day-picker` (transitive shadcn dep) or shadcn Calendar+Popover for consistent locale rendering.

### M15 — `<HostMetricsChart>` Legend on mobile — non-issue at current padding; flagged for completeness

- **File:** `src/components/admin/host-metrics-chart.tsx:299-305`
- **Issue:** none. Recharts default Legend stacks fine on 393 px viewport.

### M16 — Onboarding tour after Wave A nav changes: anchors `nav-insights`, `nav-settings`, `nav-achievements` all still present

- **File:** `src/components/layout/sidebar-nav.tsx:74, 86, 462, 515`
- **Issue:** none — verified. A1's removal of admin sub-list expansion did not touch tour anchors.
- **Recommendation:** none.

### M17 — i18n parity for new B5d/B5e/B1b/B7 keys: spot-checked 17 keys; all present in EN+DE; no raw-key surfaces

- **Files:** `messages/en.json`, `messages/de.json`
- **Issue:** none.
- **Recommendation:** none.

### M18 — `<ConfidenceMeter>` ring variant `r=10` viewBox 28×28 — fits at every call site; non-issue

- **File:** `src/components/insights/confidence-meter.tsx:144-178`
- **Issue:** flagged for record.

### M19 — Dashboard tile delta callout stays muted on `neutral` direction-sentiment metrics — visually loses the "value did move" signal

- **File:** `src/components/charts/trend-card.tsx:162-172`
- **Issue:** intentional per design (neutral metrics shouldn't be celebrated/scolded), but visually loses the signal that the metric DID change. Apple Health uses ↑/↓ arrows in muted color for neutral metrics; HealthLog has the arrow on the trend-icon but not on the delta callout.
- **Recommendation:** add a small "↑" / "↓" glyph next to the muted delta on neutral metrics so the user reads "pulse moved up by 4 bpm" not "pulse showed −0".

### M20 — Severity Badge text uppercase but uses raw EN vocabulary ("URGENT" / "IMPORTANT" / "SUGGESTION" / "INFO") — not localised

- **File:** `src/components/insights/recommendation-card.tsx:354`
- **Issue:** `<Badge>{norm.severity}</Badge>` renders the raw enum value. EN-only. DE users see English vocabulary in a German UI.
- **Recommendation:** add `insights.recommendation.severity.{urgent,important,suggestion,info}` i18n keys. EN: same words. DE: "Dringend" / "Wichtig" / "Vorschlag" / "Info".

### M21 — `<ScatterCorrelationChart>` (correlation cards on /insights) does NOT receive B1a polish

- **File:** `src/components/charts/scatter-correlation-chart.tsx`
- **Issue:** B1a polish was scoped to time-series charts (HealthChart, MoodChart, MedicationCompliance). Scatter correlations on /insights still use the v1.4.0 visual style — abrupt visual delta when scrolling from BP timeline (polished) to BP-vs-weight scatter (legacy).
- **Recommendation:** v1.4.17 — extend ChartLinearGradient + RichChartTooltip to the scatter wrapper for visual coherence.

### M22 — `MedicationComplianceChart` 80% threshold + 100% goal lines + personal-baseline label may stack on the same y-position

- **File:** `src/components/charts/medication-compliance-chart.tsx`
- **Issue:** flagged from skim (A6 added 80% + 100% lines, B1a added baseline). Can't confirm without live render. Worth verifying once v1.4.16 deploys.

---

## Tally

- 3 CRITICAL (C1, C2, C3) — all three are "the polish shipped but isn't visible to the user". One coherent root cause: scope-completion-without-route-wiring.
- 8 HIGH (H1–H8) — accessibility (44 px hit areas, focus-visible, severity-uppercase i18n) + chart consistency (compareBaseline gap on med-compliance) + DE-locale fallback-chain row overflow
- 22 MED/LOW (M1–M22) — polish, second-pass parity, simplification opportunities for v1.4.17

Recommendation to release reconcile: prioritise **C1, C2, C3** above all H/M items. Without C1/C2/C3, v1.4.16 is internally a giant code release but externally a v1.4.15 + comparison-overlay-via-Settings + admin polish + AI-quality-table release. The headline "Apple Health–quality recommendations with confidence + thumbs feedback" is true *in the codebase* but not on Marc's screen.

If C1/C2/C3 cannot be wired in this cycle, the v1.4.16 release notes / Marc-Brief should be honest about it: phrase the polish as "groundwork for v1.4.17 user-facing rollout" rather than "the headline UX leap", and explicitly remove screenshots of the unmounted components from any marketing material.

---

## What I could not verify (Playwright not used)

The brief offered Playwright with Marc's session against `https://healthlog.bombeck.io` IF v1.4.16 was deployed. STATE.md shows v1.4.15 live, v1.4.16 phases complete but no E in tag-and-deploy. Source-code audit was the available approach. Specific live-render checks deferred:

- Actual gradient appearance on Pixel 5 LCD vs spec (H5)
- Tap-target measurements via DevTools mobile emulation (H1, H2, H6)
- Reduced-motion user-agent override on the staggered loading skeleton (M11)
- Sticky section-nav back-swipe interference on iOS Safari (M7)
- DE-locale fallback-chain row overflow on Pixel 5 (H8)
- MedicationComplianceChart label-stack live render (M22)

Once v1.4.16 deploys, a 30-minute Playwright pass against `cmox4d6fj000101p8w9ykhcnm` should validate or invalidate H5/H6/H8/M7/M11/M22.
