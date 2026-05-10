# Phase D — Design / UX review (v1.4.19)

Marathon: v1.4.19 Wave-D
Reviewer: design / UX agent (parallel with code, security, senior-dev,
simplify, product-lead)
Date: 2026-05-10
Method: source-code review against the local working tree at
`origin/main` (`14eff96`); production probe deferred — `/api/version`
still reports `1.4.18`, the v1.4.19 image hasn't deployed yet, so
Playwright probes against prod would not exercise the changes under
review. Findings keyed to file + line numbers in the working tree.

## Scope

Pages audited:
- `/dashboard` (`src/app/page.tsx`)
- `/insights` (`src/app/insights/page.tsx`,
  `src/components/insights/insights-page-hero.tsx`)
- Settings shell — `/settings/{account,profile,dashboard,ai,
  notifications,integrations,export}`
  (`src/components/settings/*.tsx`)
- `/admin/feedback`, `/admin/api-tokens`
  (`src/components/admin/{feedback-inbox-section,
  api-token-overview-section}.tsx`)
- Zielwerte (`src/app/targets/page.tsx`)
- Charts (`src/components/charts/{health,mood,
  medication-compliance}-chart.tsx`,
  `src/components/charts/chart-overlay-controls.tsx`)
- Comparison toggle (`src/components/comparison/compare-toggle.tsx`)

## Cross-cutting checks (all passed)

- **Marc's chart-revert holds.** Verified across `health-chart.tsx`,
  `mood-chart.tsx`, `medication-compliance-chart.tsx`:
  - No `linearGradient` / `<defs>` background fills under chart lines
    (grep on `src/components/charts/`, zero matches outside tests).
  - No emoji glyphs in any chart (grep on `smile|emoji|😀😢😊🙂😐😞`,
    only matches are explicit reverts in `mood-chart.tsx:478` and the
    `mood-chart-polish.test.tsx` regression suite that pins the
    revert).
  - Personal-baseline / mean reference line is gated behind the
    `showTrend` (`showTrendArrow`) overlay toggle in both
    `health-chart.tsx:1101` and `mood-chart.tsx:637`. Default state
    in `DEFAULT_CHART_OVERLAY_PREFS`
    (`src/lib/dashboard-layout.ts:127-130`) is
    `showTrendIndicator: false`, `showTrendArrow: false`,
    `showTargetRange: false` — clean line is the default for every
    chart, overlays are user-opt-in.
- **i18n EN/DE parity.** Programmatic flatten + diff of
  `messages/en.json` vs `messages/de.json`: zero EN-only keys, zero
  DE-only keys. New `settings.integrationPill.*` and `targets.label.*`
  / `targets.status.*` blocks present in both locales.
- **Umlaute intact.** `messages/de.json` contains `ö ü ß` correctly
  (`gerade eben`, `vor {count} Std.`, `Wähle einen Bereich`,
  `Hypertonie`, etc.). No mojibake.
- **Typecheck clean** (`pnpm typecheck` exits 0).
- **A3 chart-token leak fixed.**
  `STRIP_TOKEN_REGEX = /metric:[A-Za-z0-9_]+/g` in
  `src/lib/insights/chart-tokens.ts:54` — lowercase / snake_case
  tokens like `metric:blood_pressure_sweet_spot` now strip out of
  prose. `PARSE_TOKEN_REGEX` (uppercase only) keeps the render
  allowlist tight.
- **A1 BD-Zielbereich.** `src/app/api/analytics/route.ts:82-85` now
  routes the headline through `windows.allTime?.pct`; sub-values
  retain `last7Days` / `last30Days`. Three numbers can now diverge
  (the deploy will surface ~11 % headline vs 50 / 50 sub-values for
  Marc's data; pre-fix all three were 50 %).
- **A5 status-pill consolidation.** Withings + Mood Log cards each
  render exactly one `<IntegrationStatusPill>` top-right of the
  header followed by a `<hr>` divider — both
  `src/components/settings/integrations-section.tsx:336-352` and
  `:633-660`. The v1.4.15 redundant banner is gone; Mood Log's
  bottom-of-card "letzter Sync" is gone; lastError surfaces as a
  compact `<IntegrationErrorMessage>` only on transient failure.
- **A7 admin polish.**
  - Feedback tab strip carries `overflow-y-hidden` on `tabsListVariants`
    (`src/components/ui/tabs.tsx:48`). Browsers no longer paint a
    silent y-axis scrollbar on short strips.
  - `/admin/api-tokens` Einklappen button removed.
  - Token name + username + permission badge wrapped in
    `<TruncatedCell>`; `<colgroup>` widths set on the desktop table.
  - Zielwerte page: `space-y-6` outer wrapper
    (`src/app/targets/page.tsx:656`); status labels routed through
    `STATUS_CATEGORY_KEY` map at line 115 → translated DE labels.

## CRITICAL — 0

(None.)

## HIGH — 2

### H-01 — Truncated cells on `/admin/api-tokens` are unreadable on touch

- **Severity:** HIGH
- **File:** `src/components/admin/api-token-overview-section.tsx:37-56`
  + `src/components/ui/tooltip.tsx:1-58`
- **Issue:** The 4th-attempt truncate-with-tooltip pattern wraps long
  token names / usernames / permission badges in a Radix
  `<Tooltip>` plus a native `title=` attribute. Neither surfaces
  the truncated text on touch:
  - Radix Tooltip triggers on hover + keyboard-focus only — touch
    does NOT open it (Radix Tooltip docs explicitly call this out;
    Tooltip is not the touch primitive).
  - Native `title=` is ignored by iOS Safari and renders
    inconsistently on Android (long-press behaviour is OS-dependent
    and the user expects an obvious "View full text" affordance,
    not a browser tooltip).

  Result: on Pixel-5 / iPhone, a long auto-issued token name such as
  `web auto-login · 05.05.2026 19:46 (foo bar baz)` truncates with
  no way to read the full string. The new `formatTokenName()` helper
  (line 69) shortens the ISO suffix, which helps for the common case
  but does not cover manually-named tokens or tokens with extra
  trailing context.

  Marc's brief explicitly listed this as a check: "Tooltip on
  truncated api-tokens cells works on touch (long-press on mobile,
  hover on desktop)". The hover path works; the touch path does
  not.
- **Recommendation:** On the mobile card-list (`md:hidden`, line
  232), drop `truncate` and let long values wrap to two lines —
  vertical space is cheap on a card and reading is more important
  than visual neatness. Alternatively, switch to a Radix Popover
  (which DOES handle touch via tap-to-toggle) and mount the full
  string inside. Desktop table can keep the existing hover tooltip.
- **Ship-blocker?** No — but the brief named this explicitly, so
  land in v1.4.19 patch (cheap fix) rather than defer.

### H-02 — Insights hero stacks 3 + 1 controls on Pixel-5; vertical density

- **Severity:** HIGH
- **File:** `src/components/insights/insights-page-hero.tsx:101-163`
- **Issue:** When the comparison toggle (`metaSlot`) is mounted AND
  the regenerate button is wired (the live `/insights` config), the
  outer flex `flex-col gap-4 sm:flex-row sm:items-start
  sm:justify-between` puts the regenerate button in a 2nd column on
  desktop; on mobile (`<sm`) it stacks below the meta-slot. The
  meta-slot itself wraps the `<CompareToggle>` (3 buttons, each
  `min-h-11 px-3`).

  On Pixel-5 (393 px page width minus `px-4 = 32 px = 361 px content`),
  the EN copy "None / Last month / Last year" plus borders + gaps
  measures ~245 px — fits, no wrap. The DE copy "Aus / Vormonat /
  Vorjahr" is shorter — also fits.

  The legibility risk is **vertical density**: title (32 px) +
  subtitle (~20 px line) + baseline-meta row (~16 px) +
  CompareToggle band (44 px tall) + Regenerate band (32 px) ≈ 144 px
  before any card body. Marc's A3 concern was "three stacked cards
  with separate controls" feel; folding the toggle into the hero
  removed the standalone band but made the hero itself heavy.
- **Recommendation:** On `>=sm`, inline the CompareToggle next to
  the Regenerate button (both in the right-side column) instead of
  inside the title block. On `<sm`, keep the current stacked layout
  but shrink the toggle from `min-h-11` to `h-9` (matching the
  Settings input contract) — the segments are still well above the
  24-px WCAG floor.
- **Ship-blocker?** No — the hero IS legible, just visually busier
  than the brief implies. Hold for v1.4.20 hero redesign.

## MED — 4

### M-01 — `/admin/api-tokens` still has duplicate page title

- **Severity:** MED
- **File:** `src/app/admin/[section]/renderer.tsx:123-131,180-192`
  + `src/components/admin/api-token-overview-section.tsx:101-106`
- **Issue:** `SectionFrame` renders `<h1>API Tokens</h1>`
  (renderer line 184) AND `<ApiTokenOverviewSection>` body renders
  `<div class="text-lg font-semibold">API Tokens</div>` (section
  line 105). User reads "API Tokens" twice in the same scroll.
  Wave-B F-08 sweep cleared this on `/admin/danger-zone` and
  `/admin/feedback` but explicitly deferred api-tokens
  (`.planning/phase-B-quality-report.md` notes "Other affected pages
  deferred"). Marc's brief did not name this for api-tokens, only
  the no-Einklappen rule.
- **Recommendation:** Drop the inner card title — the `Key` icon is
  already the visual anchor and SectionFrame `<h1>` carries the
  title. One commit, ~3 lines.
- **Ship-blocker?** No.

### M-02 — Profile DOB still wrapped in a 2-col grid with one cell

- **Severity:** MED
- **File:** `src/components/settings/account-section.tsx:383-398`
- **Issue:** A6 lifted Sprache out of the dob/language pair; the
  remaining `<div class="grid gap-4 sm:grid-cols-2">` now wraps a
  single `<div class="space-y-2">` for date-of-birth. On `>=sm`
  this paints DOB at half-card width (correct), on mobile the grid
  is 1-column (correct), but on desktop the right cell renders
  empty without a placeholder — visually fine, semantically odd.
- **Recommendation:** Replace the grid with a plain `<div
  class="sm:max-w-md">` so the DOB input still caps at half-card
  width on desktop. Drops one DOM node + one CSS class.
- **Ship-blocker?** No.

### M-03 — Chart range tabs (`min-h-11`) read heavier than v1.4.19 Settings inputs (`h-9`)

- **Severity:** MED
- **File:** `src/components/charts/health-chart.tsx:920` +
  `mood-chart.tsx:571` + `medication-compliance-chart.tsx:302`
- **Issue:** A6 standardised every Settings input to `h-9` (36 px).
  Chart range tabs are `min-h-11 px-2 sm:px-3` (44 px+) for
  WCAG 2.5.5 touch-target compliance. Both choices are individually
  correct, but on the dashboard the eye reads the range-tab band as
  taller than the BD-Zielbereich tile and the BMI card's value — a
  subtle inconsistency. Marc's brief explicitly invoked input-
  height consistency for Settings; charts weren't named, so this is
  more "noticed during review" than "broken".
- **Recommendation:** Either accept (charts are a different surface
  and 44-px touch targets matter on cards the user actually drags)
  or shrink to `h-9` on `>=sm` and keep `min-h-11` on `<sm`. Defer
  to v1.4.20 chart redesign.
- **Ship-blocker?** No.

### M-04 — Mood Log "Copy webhook secret" button uses success-toast string as resting label

- **Severity:** MED
- **File:** `src/components/settings/integrations-section.tsx:715-725`
- **Issue:** The button copies `status.webhookSecret` to clipboard
  and sets the success message to `t("common.copied")` which
  resolves to "Copied!" / "Kopiert!". The button label itself is
  `t("common.copied").replace("!", "")` — using the just-set
  success-message string as the resting button label. Works in
  practice (the value resolves to "Copied" / "Kopiert" without
  the bang) but is semantically wrong: the resting-state label of
  a copy button should be "Copy", not "Copied". Pre-existed
  v1.4.19; A5 refactored the surrounding card without touching
  this row.
- **Recommendation:** Add `common.copy` keys (en: "Copy",
  de: "Kopieren") and use them for the button label; keep
  `common.copied` for the post-click toast. One commit, 4 lines.
- **Ship-blocker?** No.

## LOW — 4

### L-01 — Insights hero relative-time spells out "minutes / hours / days"; status pill abbreviates

- **Severity:** LOW
- **File:** `src/components/insights/insights-page-hero.tsx:60-74`
  vs `src/components/settings/integration-status-pill.tsx:52-67`
- **Issue:** Insights hero EN: "{count} minutes ago". Pill EN:
  "{count} min ago". DE: "vor {count} Minuten" vs "vor {count}
  min". The two surfaces show two different conventions for the
  same fact. Both are locale-correct individually; the
  inconsistency is the issue. Pre-existing across v1.4.16 / v1.4.18,
  not a regression.
- **Recommendation:** Document a convention (abbreviate in chips,
  spell out in prose) in `feedback_marc_voice_english.md` or a new
  feedback note. No code change required for v1.4.19.
- **Ship-blocker?** No.

### L-02 — Insights hero baseline + generated cluster orphans the dot separator on Galaxy Fold compact (280 px)

- **Severity:** LOW
- **File:** `src/components/insights/insights-page-hero.tsx:115-128`
- **Issue:** The baseline indicator + generated-line cluster uses
  `flex flex-wrap items-center gap-x-3 gap-y-1` so the
  middle-dot separator hangs at the start of a wrapped 2nd line
  on Galaxy Fold compact:
  ```
  Based on your last 90 days
  · Generated 3 minutes ago
  ```
  Cosmetic only — A2's audit declared Galaxy Fold compact a
  "best-effort, not a target" viewport.
- **Recommendation:** Use `before:content-['·']` on the
  generated-line span instead of a separate dot span, so wrapping
  drops the dot cleanly. Or accept and move on.
- **Ship-blocker?** No.

### L-03 — `/admin/api-tokens` desktop `lastUsedAt` cell can clip the seconds

- **Severity:** LOW
- **File:** `src/components/admin/api-token-overview-section.tsx:135-142,
  213-220`
- **Issue:** The colgroup widths sum to `18+28+24+10+12+8 = 100 %`.
  `lastUsedAt` cell is `whitespace-nowrap` rendering
  `formatDateTime(...)` (e.g. "10.05.2026, 13:18:42" — 19 chars +
  px-3 padding ≈ 145 px). At a 1024-px-wide table, the 10 % cell
  is ~102 px which clips the seconds. The mobile-list e2e at
  `e2e/admin-api-tokens-mobile.spec.ts` doesn't catch this because
  it only walks the card-list `scrollWidth`.
- **Recommendation:** Either widen lastUsed/created columns to
  12 % each (drop username to 16 % and permissions to 22 %), or
  format the timestamp without seconds (`dd.mm.yyyy hh:mm` —
  matches the new ISO-suffix renderer at line 80). Latter is
  simpler.
- **Ship-blocker?** No.

### L-04 — IntegrationStatusPill aria-label is generic across all 3 states

- **Severity:** LOW
- **File:** `src/components/settings/integration-status-pill.tsx:120`
- **Issue:** The pill's `aria-label` is always
  `t("settings.integrationPill.ariaLabel")` ("Integration status" /
  "Integrationsstatus") regardless of state. A screen-reader user
  hearing "Integration status, Connected, 12 minutes ago" gets the
  state from the visible label text — but the explicit aria-label
  duplicates that text without adding the state. Drop or
  parametrise.
- **Recommendation:** Either drop the `aria-label` (the visible
  Badge text + relative time are already announced) or parametrize
  per state. Drop is the lower-effort path.
- **Ship-blocker?** No.

## Notes for v1.4.20 backlog

- M-03 (chart range-tab height vs Settings input height) is best
  resolved during the v1.4.20 Insights redesign — that effort
  redraws the chart cards anyway.
- H-02 (hero density on Pixel-5) overlaps with the v1.4.20
  redesign brief; if the hero is rebuilt, fold the meta-slot
  inline with the regenerate button.

## Verification commands run

- `pnpm typecheck` — clean (0 errors).
- `python3 i18n flatten + diff` — zero EN-only / DE-only keys.
- `grep linearGradient|<defs>` on `src/components/charts/` —
  zero matches outside test files.
- `grep smile|emoji|😀😢😊🙂😐😞` on charts + insights — only
  hits are explicit reverts + their pin tests.
- Source-code review of the 7 audited surfaces above.

## Production-probe deferred

`/api/version` reports `1.4.18` at probe time
(`curl https://healthlog.bombeck.io/api/version`). The v1.4.19
image is on the local `origin/main` but has not been deployed to
Coolify, so a Playwright run against prod would exercise v1.4.18
code, not v1.4.19. The findings above are sourced from the
working tree; once Phase E ships v1.4.19, the next marathon's
parallel design agent should re-probe at Pixel-5 + iPhone 12 +
Fold compact and reconcile against this report.
