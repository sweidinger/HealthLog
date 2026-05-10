# Phase D — DESIGN/UX review (v1.4.18)

Reviewer: design / UX (parallel run with 5 other reviewers)
Mode: source audit (production was on v1.4.17 at audit time, v1.4.18
not yet deployed; `/api/version` returned 1.4.17 at probe)
Branch state: origin/main pulled, 7 untracked stale files left in
place (4 v1.4.16-era export route dirs + 3 v1.4.16 phase-E reports);
none touch the surfaces under review.

Scope of audit:

- `/dashboard` charts after v1.4.18 A3 chart revert + per-chart toggle
- `/insights` (no regression check on RecommendationCard)
- `/admin/api-tokens` + other admin/settings sections (no-scrollbar
  utility from A2)
- `/achievements` (B1 expansion + hidden cards)
- BD-tile 7T/30T sub-values (A1)
- A11y, contrast, focus, mobile-friendliness, EN/DE i18n parity

## What's clean (no findings)

- **Chart revert is solid.** No `linearGradient` defs, no `chart-gradient`
  module (deleted), no emoji glyphs at mood data points (`MOOD_EMOJI`
  map removed at `mood-chart.tsx:471` with explanatory comment), no
  always-on personal-baseline reference line — the baseline is now
  gated behind the `showTrend` toggle on both `HealthChart` and
  `MoodChart`. Tests pin all three reverts (`health-chart-polish.test.tsx:146`,
  `mood-chart-polish.test.tsx:66/81`, `medication-chart-polish.test.tsx:51`).
  v1.4.16's smooth interpolation + rich tooltip + animation-on-render
  are preserved as the brief required.
- **Default overlay state is OFF for all three toggles** —
  `DEFAULT_CHART_OVERLAY_PREFS = { showTrendIndicator: false,
showTrendArrow: false, showTargetRange: false }` at
  `chart-overlay-controls.tsx:165`. Pinned by
  `health-chart-overlay-defaults.test.tsx`.
- **EN+DE i18n parity for new strings.** `chart.overlay.controls.{title,
trendIndicator,trendArrow,targetRange,tooltip.openSettings}` exist
  in both `messages/en.json:652-664` and `messages/de.json:652-664`.
  `achievements.{hiddenCard,hiddenUnlockToast,categories.hidden}` exist
  in both at the same offsets.
- **Hidden-achievement DOM redaction works.** Locked hidden cards
  render via the early-return path at `achievements/page.tsx:146-174`
  with no `titleKey` / `descriptionKey` / `metric` / `target` / `current`
  in the rendered output. Test pins:
  `achievements/__tests__/page.test.tsx:252-262` asserts neither
  "Night owl" nor "Logged an entry between 02:00 and 04:00" nor
  "nightOwlCount" appears in the DOM. Once unlocked, real strings
  appear (`page.test.tsx:264-269`).
- **No-scrollbar utility scope is appropriate.** Used only on the
  intended `<nav>` strips in `<AdminShell>:160` and `<SettingsShell>:143`.
  No accidental application elsewhere — `git grep no-scrollbar src/`
  returns only the CSS definition + the two shells + their tests.
- **BD-Zielbereich 7T/30T sub-values now wire to real data.** Fields
  `bpInTargetPct7d` / `bpInTargetPct30d` sourced from
  `computeBpInTargetWindows()` flow through `dashboard/page.tsx:817-818`
  into `<TrendCard>`. The `renderPair()` helper at
  `trend-card.tsx:187-196` cleanly fall-throughs to `"—"` only when the
  window genuinely has no paired readings.
- **Achievements API summary excludes hidden from `nextAchievement`.**
  Route filters `!a.unlocked && !a.isHidden` at
  `gamification/achievements/route.ts:835`, so the "Next goal" tile on
  /achievements never accidentally points to a secret.

## CRITICAL

(none)

## HIGH

### H1 — `/insights` mood chart silently mounts the dashboard's overlay-controls dropdown

- **Severity:** HIGH (regression / cross-page state surprise)
- **File:** `src/components/charts/mood-chart.tsx:273` (default
  `chartKey = "mood"`); usage at `src/app/insights/page.tsx:1479`
- **Issue:** `<MoodChart>` declares `chartKey = "mood"` as the default
  prop value, so any consumer that omits the prop — including `/insights`
  — picks up the dashboard's persisted overlay prefs **and** renders
  the cog-settings dropdown next to the range tabs. Toggling
  `showTrendArrow` from `/insights` immediately re-renders the
  dashboard's mood chart with the same flag because the persistence
  key is shared (`useChartOverlayPrefs("mood")`). The brief explicitly
  scopes the new dropdown to "settings icon top-right of each chart"
  on the dashboard, not /insights — `/insights` is a read-only insights
  surface, not a per-chart preferences surface. Worse, `useChartOverlayPrefs`
  fires its own `GET /api/dashboard/widgets` query on /insights mount
  if the dashboard layout query isn't already in cache (deep-link to
  /insights without first visiting /dashboard).
- **Recommendation:** Make `chartKey` an opt-in prop (no default) on
  `MoodChart` to match `HealthChart`'s contract (`chartKey?:
ChartOverlayKey;` with no default, treated as "no toggles, no
  persistence" when omitted). Then explicitly pass `chartKey="mood"`
  only at the dashboard mount site (`page.tsx:982`). /insights
  `<MoodChart>` should render a clean line with no cog (matching the
  /insights `<HealthChart>` which already correctly omits chartKey).
- **Ship-blocker?** Yes if /insights is meant to stay read-only; no if
  Marc wants overlay toggles cross-page (intent should be confirmed
  before release).

### H2 — Cog-button tap target is 28×28 px (below WCAG 2.1 AA 44×44)

- **Severity:** HIGH (a11y / WCAG SC 2.5.5 Target Size, mobile UX)
- **File:** `src/components/charts/chart-overlay-controls.tsx:92`
- **Issue:** The settings-cog trigger uses
  `className="text-muted-foreground hover:text-foreground h-7 w-7 px-0"`
  → 28×28 CSS px. The neighbouring range tabs in the same flex row
  use `min-h-11 px-3` (44 px tall, ≥48 px wide). Both touch-target
  policy and visual rhythm break: a thumb tap on a Pixel 5 (393 CSS
  px wide) hits the surrounding tabs more reliably than the cog,
  especially with tabs explicitly sized for 44 px. v1.4.16 phase D
  reconcile (commit `c3451a4`) made this exact fix for the rec-feedback
  / range-tabs / export switch precisely to satisfy the 44 px rule;
  the new cog regresses on it.
- **Recommendation:** Change to `min-h-11 min-w-11` (44 × 44) and keep
  the icon size at `h-3.5 w-3.5` so the surrounding hit-area grows
  without bloating the icon visual. Alternative: absolute-position the
  cog over a 44-px hit-area outside the range-tabs row.
- **Ship-blocker?** Yes — Marc's a11y bar in v1.4.16 H1 was tap-target
  fixes; shipping a known regression on the same rule undoes that work.

### H3 — Mood-chart header lacks `flex-wrap`; cog + 4 range tabs may overflow on narrow viewports

- **Severity:** HIGH (mobile layout regression)
- **File:** `src/components/charts/mood-chart.tsx:550`
- **Issue:** `<div className="flex items-center gap-1">` wraps the
  4 range-tabs (each `min-h-11 px-3 text-xs`, ~40-50 px wide) plus
  the new cog (`h-7 w-7`). Total minimum width ≈ 200-230 px on the
  right side of the title row. Without `flex-wrap`, on a Pixel-5
  viewport (393 CSS px) inside a Card with `p-6` padding (≈48 px
  combined) the title group + bucket chip + comparison caption
  competes with this fixed-width row. `<HealthChart>:887` and
  `<MedicationComplianceChart>:273` both correctly use `flex-wrap`
  in the same position; mood is the only outlier.
- **Repro:** Pixel-5 / 393 px viewport, mood chart visible, comparison
  toggle ON ("Vormonat") → caption + tabs + cog overflow the card,
  pushing layout horizontally and either clipping the cog or forcing
  a horizontal scroll on the card.
- **Recommendation:** Add `flex-wrap` to the right-side container
  matching the `HealthChart` / `MedicationComplianceChart` siblings:
  `className="flex flex-wrap items-center justify-end gap-1"`.
- **Ship-blocker?** Yes for mobile users with comparison toggle on (a
  common v1.4.16 surface). Soft-block otherwise.

## MED

### M1 — Achievements API leaks hidden-achievement strings via the network response

- **Severity:** MED (privacy / spoiler-discoverability via DevTools)
- **File:** `src/app/api/gamification/achievements/route.ts:852`
  (default JSON), `:866-867` (iOS format also leaks)
- **Issue:** `applyDiscoveryFilter()` keeps hidden achievements in the
  response (correct — the page renders an opaque card), but the wire
  shape contains the full `AchievementProgress` for each:
  `titleKey`, `descriptionKey`, `metric`, `target`, `current`,
  `progressPercent`, `icon`. The DOM correctly redacts these (per H1
  spec), but a curious user opening DevTools → Network → the response
  JSON sees the trigger conditions verbatim ("Logged an entry between
  02:00 and 04:00 in Berlin time" via the i18n key →
  `messages/en.json` is also a public bundle). The brief says hidden
  cards "do NOT leak title/description/conditions" — DOM is satisfied,
  network channel is not. iOS clients additionally receive
  `t(a.titleKey)` / `t(a.descriptionKey)` for hidden+locked entries
  in the resolved-string `IosAchievement` shape, which is even more
  exposed.
- **Recommendation:** For `isHidden && !unlocked`, return a redacted
  shape: `{ id, isHidden: true, unlocked: false, points: 0, category:
"hidden", icon: "HelpCircle", titleKey:
"achievements.hiddenCard.title", descriptionKey:
"achievements.hiddenCard.description", target: 0, current: 0,
progressPercent: 0 }`. Once unlocked, send the real strings (the
  reveal is the reward). Same for the iOS branch.
- **Ship-blocker?** No (the i18n strings are also in the public client
  bundle so determined users can find them anyway), but the brief's
  stated goal is "user knows they exist but not what they are" — this
  is a textbook leak of "what they are".

### M2 — `recent-achievements-card.tsx` icon map is missing entries used by v1.4.18 expansion + hidden achievements

- **Severity:** MED (visual regression on dashboard recent-unlocks)
- **File:** `src/components/gamification/recent-achievements-card.tsx:32-47`
- **Issue:** `iconMap` covers 14 icons. Achievements added or referenced
  in v1.4.18 (B1) use these icon strings the dashboard recent-unlocks
  card cannot resolve and falls back to `Star`:
  - `Smile` (3 mood badges: `mood-first`, `mood-streak-7`,
    `mood-streak-30`)
  - `Scale` (2 weight badges: `weigh-50`, `weigh-200`)
  - `CalendarDays` (`consistent-month`)
  - `Moon` (`hidden-night-owl`)
  - `Sun` (`hidden-early-bird` and `mood-up-7`)
  - `Sparkles` (`hidden-leap-day`)
  - `FileText` (`hidden-doctor-pdf`)
  - `Languages` (`hidden-locale-flip`)

  The `/achievements` page (`achievements/page.tsx:53-76`) imports all
  of these correctly. Result: a user who unlocks any of the new mood,
  weight, engagement, or hidden-easter-egg achievements sees the
  generic Star icon on the dashboard while the page itself shows the
  intended icon — visual inconsistency between two surfaces of the
  same feature.

- **Recommendation:** Mirror the page's iconMap into
  `recent-achievements-card.tsx` (add the 8 missing icons), or extract
  a shared `gamificationIconMap` module so both surfaces stay in sync
  by definition.
- **Ship-blocker?** No; functional, just visually inconsistent.

### M3 — `PUT /api/dashboard/chart-overlay-prefs` has no idempotency guard or atomic merge

- **Severity:** MED (data-race + missing idempotency contract)
- **File:** `src/app/api/dashboard/chart-overlay-prefs/route.ts:41-91`
- **Issue:** Two parts:
  1. Read-modify-write race. Lines 56-76 do
     `findUnique(dashboardWidgetsJson) → resolveDashboardLayout → merge
prefs → user.update(...)`. Two concurrent toggles on different
     charts (BP and weight) flipped within ~50 ms drop one update.
     Single-user system today, but the v1.4 multi-tenant prep noted
     in CLAUDE.md means this becomes a correctness issue once shared
     household accounts ship.
  2. Missing `withIdempotency()` wrapper. CLAUDE.md says all
     POST/PUT/PATCH/DELETE handlers wrap in `withIdempotency()` so a
     retried `Idempotency-Key` from the iOS app or a flaky network
     replays the same response. The new route doesn't, so a network
     blip during a toggle save can produce inconsistent state on
     retry (the optimistic cache update + the rollback path in
     `useChartOverlayPrefs` partially papers over this, but the
     server-side guarantee is missing).
- **Recommendation:**
  - Wrap with `withIdempotency()` (matches the contract every other
    mutation route uses).
  - Use a Prisma transaction OR push the merge into a `JSONB`-aware
    update so the race is closed in the DB, not the application
    process. PostgreSQL `jsonb_set` would satisfy this.
- **Ship-blocker?** No for v1.4.18 (single-tenant), but flag for
  v1.4.19/v1.5 multi-tenant readiness (would be CRITICAL post
  multi-tenant flip).

### M4 — Cog-button alignment with 44 px range tabs is visually noisy

- **Severity:** MED (design polish)
- **File:** `src/components/charts/chart-overlay-controls.tsx:92`,
  `health-chart.tsx:887-911`, `mood-chart.tsx:550-570`,
  `medication-compliance-chart.tsx:273-291`
- **Issue:** The cog (28 px tall) sits in the same flex row as the
  range-tabs (44 px tall). Visually the cog reads as half-the-height
  of its row neighbours, making it look like an afterthought rather
  than a deliberate control. (This is the visual side of H2; H2 is
  the a11y angle.) The icon also has `text-muted-foreground` whereas
  the active range tab uses `bg-primary text-primary-foreground` —
  the cog is so quiet it's easy to miss entirely on first paint.
- **Recommendation:** Once H2 is fixed (44 × 44), bump
  `text-muted-foreground` → `text-foreground` (or use `variant="outline"`)
  so the cog reads as a peer to the range tabs. Or swap to a more
  obviously "settings" affordance — e.g. an `inline-flex` chip
  labelled "Overlays" (matches Apple Health's "Show as" surface
  pattern) so the user discovers the toggles without tap-and-pray.
- **Ship-blocker?** No; pure polish.

### M5 — Mobile section strip swipe affordance is now invisible (no scrollbar, no fade gradient)

- **Severity:** MED (discoverability regression from A2)
- **File:** `src/app/globals.css:217-223`,
  `src/components/admin/admin-shell.tsx:160`,
  `src/components/settings/settings-shell.tsx:143`
- **Issue:** A2 correctly killed the painted scrollbar Marc kept
  reporting on `/admin/api-tokens`. Trade-off: there's no longer any
  visual indication that the strip is horizontally scrollable. With
  13 admin entries (≈1700 px) on a 393 CSS-px viewport, the user
  sees the first 4-5 pills and has no cue that swiping right reveals
  the rest. Native iOS / Android scroll-momentum hints (rubber-band)
  appear only on touch, and a desktop user with no scrollbar simply
  doesn't know to swipe.
- **Recommendation:** Add a right-edge fade gradient to hint
  "more content this way" — common pattern for `no-scrollbar`
  containers. CSS-only:
  ```css
  .no-scrollbar-with-fade::after {
    content: "";
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: 24px;
    background: linear-gradient(to right, transparent, var(--card));
    pointer-events: none;
  }
  ```
  Apply to the strip parent. Or include a small chevron button on the
  right edge that scrolls the strip programmatically.
- **Ship-blocker?** No (the strip is still functional via touch
  swipe and arrow keys), but the discoverability hit means
  /admin/{deeper-section} pages are essentially hidden from non-power
  users.

### M6 — Hidden-category heading reveals the count of hidden achievements

- **Severity:** MED (mild spoiler)
- **File:** `src/app/achievements/page.tsx:421-424`
- **Issue:** The category header renders
  `{unlockedInCategory} / {items.length}` — for the hidden category
  on a fresh user this prints `0 / 6`, telling the user there are
  exactly 6 hidden achievements waiting. Marc's brief said "user
  knows they exist but not what they are"; the count borders on
  "what they are" because users will start counting until they hit 6.
  Some users may also feel pressure to unlock all 6, which arguably
  conflicts with "playful, not health-coercive".
- **Recommendation:** For the hidden category specifically, suppress
  the denominator and show only `{unlockedInCategory}` (or a `?` until
  any are unlocked). Example: `{unlockedInCategory} / ?`
- **Ship-blocker?** No; can land in v1.4.19 polish.

## LOW

### L1 — `<MedicationComplianceChart>` has no `chartKey` plumbing through props but hard-codes `"medications"` internally

- **Severity:** LOW (architectural inconsistency)
- **File:** `src/components/charts/medication-compliance-chart.tsx:180`
- **Issue:** Unlike `HealthChart` (props `chartKey?: ChartOverlayKey`)
  and `MoodChart` (default `chartKey = "mood"`), the medication chart
  hard-codes `useChartOverlayPrefs("medications")` directly with no
  prop. Any future ad-hoc render of the medication chart (rec-card
  mini? insights?) automatically reads + writes the same persistence
  slot, with no opt-out.
- **Recommendation:** Mirror HealthChart's contract: optional
  `chartKey?: ChartOverlayKey` prop, default to `"medications"` when
  used on the dashboard, omit on ad-hoc usage. Bonus: the cog can
  then be hidden on usages where toggles don't make sense.
- **Ship-blocker?** No.

### L2 — Insights `/api/dashboard/widgets` ghost fetch when only a mood chart is mounted

- **Severity:** LOW (small bandwidth hit)
- **File:** `src/hooks/use-chart-overlay-prefs.ts:36-43`
- **Issue:** Side-effect of H1: every page that mounts a `<MoodChart>`
  without explicit `chartKey={null}` triggers an extra
  `GET /api/dashboard/widgets` fetch even though the page never uses
  the layout for anything else. Negligible cost (TanStack dedupes
  inside the same query client), but it's a hidden network call.
- **Recommendation:** Lands automatically when H1 lands.
- **Ship-blocker?** No.

### L3 — `chart-overlay-controls.tsx` Settings2 icon color is identical to `text-muted-foreground` on hover-disable

- **Severity:** LOW (minor contrast on hover-state regression)
- **File:** `src/components/charts/chart-overlay-controls.tsx:92`
- **Issue:** Trigger has
  `className="text-muted-foreground hover:text-foreground"`. On
  Dracula dark theme that's `--dracula-comment` → `--dracula-foreground`,
  ≈3.5:1 → ≈14:1. WCAG 2.1 AA passes for non-text icon (3:1
  threshold), but the discoverability gap (M4) compounds with this
  low default contrast.
- **Recommendation:** Use `text-foreground/70` → `hover:text-foreground`
  (5:1 default, 14:1 hover).
- **Ship-blocker?** No.

### L4 — `chart-overlay-controls` dropdown content width (240 px) may clip on very narrow viewports near right edge

- **Severity:** LOW (radix collision detection mitigates most cases)
- **File:** `src/components/charts/chart-overlay-controls.tsx:101`
- **Issue:** `className="w-[240px] p-3"` with `align="end"
sideOffset={4}`. Radix's collision-detection re-aligns to start if
  end-align would clip the viewport. On a 360 px viewport with the
  cog near the right edge, the popover does drift left to fit, but
  the labels (especially "Trend-Pfeil" → DE longer than
  EN "Trend arrow") sit close to the right edge of the popover and
  some users may misread "Trend-Pfeil" + the switch as one row vs.
  two on the small screen.
- **Recommendation:** Confirm radix `collisionPadding` defaults are
  in play; if not, add `collisionPadding={8}`. Alternatively, drop
  the popover width to `min-w-[200px] max-w-[260px]` and let content
  size it.
- **Ship-blocker?** No.

### L5 — `<HealthChart>` ad-hoc usage on `/insights` doesn't get cog (correct), but no cue tells the user "this chart's overlays are controlled from the dashboard"

- **Severity:** LOW (informational gap)
- **File:** `src/app/insights/page.tsx:1077`, `:1280`, `:1444`, `:1601`
- **Issue:** `/insights` BP/weight/pulse charts intentionally don't
  pass `chartKey`, so they render clean lines with no toggle. A user
  who finds the dashboard cog and turns on "Trend-Pfeil" expects the
  same treatment on /insights — it doesn't show up. No tooltip or
  caption explains the difference.
- **Recommendation:** Either (a) plumb the same chartKey through so
  the user sees consistent overlay state across both pages — but
  that conflicts with the read-only insights aesthetic, OR (b) add
  a small caption to /insights charts explaining that overlays are
  set per-dashboard-card.
- **Ship-blocker?** No; informational.

## Notes for Wave-D reconcile

- **H1 + H2 + H3 are the only ship-blockers from a design lens**
  (assuming the brief's "settings icon top-right of each chart"
  scopes to the dashboard, which is how I read it).
- **All other findings are polish / consistency** that can either
  land in this release if context permits, or roll into v1.4.19
  / v1.5 backlog.
- **No CRITICAL.** The chart revert lands cleanly, the achievements
  page is well-built, and A2's no-scrollbar fix isn't fighting
  legitimate scroll affordances anywhere else in the app.
- **Achievements network leak (M1)** is worth a quick fix even at
  MED — the i18n strings ARE in the public client bundle so a
  determined user finds them anyway, but the spirit of "hidden"
  argues for the redacted-on-wire shape.

## Surfaces verified

- `src/components/charts/chart-overlay-controls.tsx`
- `src/components/charts/health-chart.tsx` (lines 289-1339)
- `src/components/charts/mood-chart.tsx` (lines 268-849)
- `src/components/charts/medication-compliance-chart.tsx`
- `src/hooks/use-chart-overlay-prefs.ts`
- `src/lib/dashboard-layout.ts` (lines 105-287)
- `src/app/api/dashboard/chart-overlay-prefs/route.ts`
- `src/app/api/gamification/achievements/route.ts`
- `src/app/achievements/page.tsx`
- `src/app/page.tsx` (chart wiring lines 870-1046, BD-tile 800-825)
- `src/app/insights/page.tsx` (chart usage 1077, 1280, 1444, 1479, 1601)
- `src/components/gamification/recent-achievements-card.tsx`
- `src/components/gamification/achievement-unlock-notifier.tsx`
- `src/components/admin/admin-shell.tsx` (no-scrollbar)
- `src/components/settings/settings-shell.tsx` (no-scrollbar)
- `src/app/globals.css` (no-scrollbar utility, lines 195-223)
- `messages/en.json` + `messages/de.json` (chart.overlay.controls._,
  achievements.hidden_, achievements.categories.hidden parity)

## Test surfaces verified

- `src/components/charts/__tests__/chart-overlay-controls.test.tsx`
  (3 cases — labels, defaults, onChange contract)
- `src/components/charts/__tests__/health-chart-overlay-defaults.test.tsx`
  (default-OFF SSR pin)
- `src/components/charts/__tests__/health-chart-polish.test.tsx`
  (no linearGradient defs, no chart-gradient)
- `src/components/charts/__tests__/mood-chart-polish.test.tsx`
  (no linearGradient, no mood-emoji-glyph)
- `src/components/charts/__tests__/medication-chart-polish.test.tsx`
  (no linearGradient)
- `src/app/achievements/__tests__/page.test.tsx`
  (hidden DOM redaction, hidden card data-slot, EN+DE category
  heading, locale-localized "Versteckt")
- `src/components/admin/__tests__/admin-shell.test.tsx`
  (no-scrollbar class assertion)
- `src/components/settings/__tests__/settings-shell.test.tsx`
  (no-scrollbar class assertion)

End of design findings.
