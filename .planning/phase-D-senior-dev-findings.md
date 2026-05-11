# v1.4.19 Phase D — Senior-Dev Review

**Lens:** architecture / file-size / naming / separation. NOT
correctness/bugs (those go to code-reviewer).

**Scope:** files touched by `git diff v1.4.18...HEAD`. Also calls out
pre-existing structural issues that v1.4.19 layered onto without
addressing.

**Verdict summary:** Zero ship-blockers. The new modules
(`charts/x-axis-density.ts`, `use-viewport-width`, `IntegrationStatusPill`)
are correctly layered. The largest finding is HIGH H-1 copy-paste
(`lang={locale}` repeated 14× across 9 files) — should land in a
follow-up before v1.5 because the same fix is bound to be needed
for any future date input. Two MED findings concern duplicated
`AUTH_ACTION_LABELS` maps and duplicated chart-header layout
patterns. Pre-existing LOW debt (1730-line `ai-section.tsx`,
1360-line `health-chart.tsx`, 831-line `integrations-section.tsx`)
noted but is not v1.4.19's regression.

---

## CRITICAL

(none)

---

## HIGH

### H-1 — `lang={locale}` copy-pasted across 9 files / 14 callsites

- **Severity:** HIGH
- **Files:**
  - `src/app/onboarding/page.tsx:307`
  - `src/components/settings/account-section.tsx:389`
  - `src/components/settings/export-section.tsx:266,279`
  - `src/components/medications/intake-history-list.tsx:548,562,694,708`
  - `src/components/medications/medication-form.tsx` (one)
  - `src/components/mood/mood-list.tsx:575`
  - `src/components/mood/mood-form.tsx:138`
  - `src/components/measurements/measurement-list.tsx:590`
  - `src/components/measurements/measurement-form.tsx:364`
  - `src/components/doctor-report/doctor-report-dialog.tsx:197,214`
- **Issue:** F-04 (Wave B) shipped the same `lang={locale}` JSX-prop
  patch into 14 callsites in 9 files. Every callsite now imports
  `locale` from `useTranslations()` purely to feed the `lang` prop.
  The pattern is mechanical and identical, and v1.4.20+ will keep
  needing it for any new date input — guaranteed drift target. As
  of HEAD, `grep -rn 'lang={locale}'` returns exactly 14 hits and
  every `<Input type="date">` / `<Input type="datetime-local">`
  callsite carries it (verified via `grep -c
'type="date(time-local)?"`). Future date inputs added without
  the prop will silently regress.
- **Recommendation:** Introduce a thin wrapper
  `src/components/ui/date-input.tsx` (or `localized-date-input.tsx`)
  that wraps `<Input>` + reads `useTranslations()` internally to
  set `lang`. Replaces every `<Input type="date" lang={locale} … />`
  with `<DateInput … />` and `<Input type="datetime-local"
lang={locale} … />` with `<DateTimeInput … />`. Eliminates the
  14× duplication and the parent-component `locale` import noise.
- **Ship-blocker?** No. The pattern works correctly today; the
  refactor is hygiene. Recommend follow-up commit before v1.5
  iOS work to keep the new APIs symmetric.

### H-2 — `AUTH_ACTION_LABELS` map duplicated verbatim across two admin sections

- **Severity:** HIGH
- **Files:**
  - `src/components/admin/login-overview-section.tsx:70-82`
  - `src/components/admin/recent-audit-preview.tsx:50-60`
- **Issue:** Identical 11-key `Record<string, string>` mapping
  `auth.*` audit-action codes to translated labels lives in two
  components. v1.4.19 ADDED 3 new entries
  (`auth.token.autoissue.native`, `auth.token.refresh`,
  `auth.token.revoke`) and the new entries had to be inserted in
  BOTH copies (commit `bc81fd7`). This is the textbook drift
  trap: future audit actions added to one map but forgotten in
  the other will render the raw enum string in one surface and a
  label in the other. Also: both maps are constructed in the
  component body via `t()`, so the literal object is rebuilt on
  every render even though the values only change with locale
  (see M-3).
- **Recommendation:** Lift to a shared hook
  `useAuthActionLabels()` in `src/components/admin/_shared.tsx`
  (already the home for `AdminUser`, `AdminAuditEntry`, etc.) that
  takes `t` from `useTranslations()` and returns a `useMemo`-cached
  `Record<string, string>` keyed on `locale`. Both consumers
  import and call it. New audit-action codes only need to be
  added once.
- **Ship-blocker?** No. Both copies are currently in sync.

### H-3 — Withings/MoodLog card chrome duplicated; future Apple Health card will copy-paste again

- **Severity:** HIGH
- **File:** `src/components/settings/integrations-section.tsx`
  (`WithingsCard` lines 199-531, `MoodLogCard` lines 533-831)
- **Issue:** A5 successfully introduced `IntegrationStatusPill` for
  the status chip, but the _card chrome_ itself
  (`<div className="bg-card border-border rounded-xl border p-6">`
  → header row with icon + title + pill → `<p>` muted description
  → `<hr data-testid="integration-card-divider"
className="border-border/60 mt-4">` → `<div className="mt-4
space-y-4">` body) is duplicated verbatim between WithingsCard
  and MoodLogCard. The Phase A5 report explicitly mentions
  _"Reusable for v1.4.20 Apple Health card on iOS"_ — but the
  reusable surface today is only the pill, not the card. Adding
  Apple Health will paste the same chrome a third time.
- **Recommendation:** Extract `<IntegrationCard>` co-located with
  `IntegrationStatusPill`. Props:
  - `icon: LucideIcon`
  - `title: string` (or `titleSlot: ReactNode` for the link-
    wrapped MoodLog title)
  - `description: string`
  - `pillState`, `pillLastSyncAt` (passed to inner pill)
  - `errorMessage?: string`
  - `children` (the unique card body — credentials form, sync
    button, etc.)
    Both existing cards become a thin shell + their unique body
    forms. Apple Health card v1.5 ships as ~30 lines of unique
    form, not ~200 lines of mostly chrome.
- **Ship-blocker?** No. Defer to v1.4.20 or v1.5 (would touch
  v1.4.19's tested surface, not worth the risk pre-release).

---

## MEDIUM

### M-1 — Chart wrapper "mobile-stack header" pattern duplicated 3×

- **Severity:** MEDIUM
- **Files:**
  - `src/components/charts/health-chart.tsx:867`
  - `src/components/charts/mood-chart.tsx:514`
  - `src/components/charts/medication-compliance-chart.tsx:269`
- **Issue:** A2 introduced an identical mobile-first header
  layout (`flex flex-col gap-2 sm:flex-row sm:items-center
sm:justify-between`) plus the matching chip-hide rules
  (`hidden sm:inline-flex` on bucket chip + comparison chip) in
  three chart components. The same 4× `<Button>` time-range tab
  loop on `TIME_RANGES_KEYS` is duplicated between health-chart
  and mood-chart (which already had a `TIME_RANGES_KEYS` clone —
  see M-2). The fix shipped 3 separate JSX blocks that must be
  kept in lockstep for header behaviour to stay consistent
  across the dashboard's chart grid. A future "header should
  also wrap on tablet portrait" tweak would have to be applied
  three times.
- **Recommendation:** Extract `<ChartCardHeader>` taking `title`,
  `bucket`, `compareCaption`, `rangePoints`, `onRangeChange`,
  `overlayMenu` slots. All three charts mount it. Side-effect:
  any future cog-menu addition / time-range change happens once.
- **Ship-blocker?** No. Lockstep is currently in sync (single
  commit `77a3ad3`); just risky long-term.

### M-2 — `TIME_RANGES_KEYS` array duplicated verbatim in two charts

- **Severity:** MEDIUM
- **Files:**
  - `src/components/charts/health-chart.tsx:45-66`
  - `src/components/charts/mood-chart.tsx:91-112`
- **Issue:** Pre-existing duplication, NOT introduced by v1.4.19.
  Calling out because A2 layered new tick-density wiring on top
  of this duplication rather than dedupe-then-extend.
  `MedicationComplianceChart` defines its own range source, and
  `ComplianceLineChart` defines its own again — no shared
  abstraction at all between the four chart wrappers' time-range
  controls.
- **Recommendation:** Move the 4-entry array to
  `src/lib/charts/time-ranges.ts` (co-locate with the new
  `x-axis-density.ts` under `src/lib/charts/`). Fold M-1 in by
  having `<ChartCardHeader>` import the constant directly.
- **Ship-blocker?** No. Pre-existing.

### M-3 — `AUTH_ACTION_LABELS` is rebuilt every render

- **Severity:** MEDIUM (perf hygiene)
- **Files:** `src/components/admin/login-overview-section.tsx:70`,
  `src/components/admin/recent-audit-preview.tsx:50`
- **Issue:** Both maps are declared inside the component body
  (not via `useMemo`), so React rebuilds an 11-key object on
  every render. Not load-bearing for the small surfaces here but
  the H-2 lift-out should pair with `useMemo([locale])` to make
  the cleanup correct in one shot.
- **Recommendation:** Resolved naturally by H-2 fix
  (`useAuthActionLabels()` returning a memoised value).
- **Ship-blocker?** No.

### M-4 — F-02 "auth.\* filter" rule expressed in two places

- **Severity:** MEDIUM
- **File:** `src/components/admin/login-overview-section.tsx:96
  - 256`
- **Issue:** F-02's "filter to `auth.*` actions" rule is
  expressed in two places: (1)
  `params.set("filter", "auth")` on the API query at line 96, and
  (2) `actions.filter((a) => a.startsWith("auth."))` on the
  dropdown options at line 256. Both must agree for the UI to
  make sense. If the server-side `?filter=auth` semantics ever
  drift from "names start with `auth.`" the UI dropdown will
  silently diverge.
- **Recommendation:** Single named constant
  `const AUTH_ACTION_PREFIX = "auth.";` plus a helper
  `isAuthAction(s) => s.startsWith(AUTH_ACTION_PREFIX)`. Use both
  in the component AND when building the URL param. (Alternative:
  derive the `?filter=` value from the prefix — `filter` query
  string maps to "subset of audit actions whose name starts with
  the supplied prefix".)
- **Ship-blocker?** No.

### M-5 — Insights advisor-card title-guard shipped 4× instead of consolidating

- **Severity:** MEDIUM
- **File:** `src/components/insights/insight-advisor-card.tsx`
  (lines 344, 377, 485, 552)
- **Issue:** A3 made the `title` prop optional and shipped the
  same `{title && <p …>{title}</p>}` guard four times — once per
  card-state branch (loading / error / empty / populated). The
  existing four-branch render structure is the root cause; v1.4.19
  added four more lines of guard rather than refactoring the
  branches into a shared `<CardHeader title={title}>` wrapper.
- **Recommendation:** Extract a local
  `<AdvisorCardHeader title?: string>` that owns the
  `<CardTitle>` + optional subtitle + Sparkles icon, and have
  every branch mount it.
- **Ship-blocker?** No. Pre-existing branch sprawl; A3 just made
  it slightly worse.

---

## LOW

### L-1 — `ai-section.tsx` is 1730 lines / 14 internal functions

- **Severity:** LOW (pre-existing, not v1.4.19's regression)
- **File:** `src/components/settings/ai-section.tsx` (1730 lines)
- **Issue:** Single file holds `AiSection`, `AiInsightsCard`,
  `ProviderStatusBadges`, `ActiveProviderSelect`,
  `ProviderConfigCard`, `CodexProviderForm`, `OpenAIProviderForm`,
  `AnthropicProviderForm`, `LocalProviderForm`,
  `AdminOpenAIProviderForm`, `FallbackChainCard`,
  `AddProviderControl`, `RuntimeActionsRow` plus three helper
  functions. v1.4.19 only changed input heights here (`h-10` →
  `h-9`, A6) — did NOT grow the file. But this file is at the
  threshold where an editor jumps multiple thousand lines to find
  a callsite.
- **Recommendation:** Defer to v1.4.20 or v1.5. Split into
  `ai-section/{index, active-provider-select,
provider-config-card, forms/{codex, openai, anthropic, local,
admin-openai}, fallback-chain-card, runtime-actions-row}.tsx`.
  Mirrors how `src/components/admin/` is structured (one section
  per file).
- **Ship-blocker?** No.

### L-2 — `integrations-section.tsx` is 831 lines (WithingsCard + MoodLogCard co-located)

- **Severity:** LOW (pre-existing)
- **File:** `src/components/settings/integrations-section.tsx`
  (831 lines)
- **Issue:** Top-level `IntegrationsSection` is fine, but
  `WithingsCard` (~334 lines) and `MoodLogCard` (~298 lines) plus
  the new helpers (`useIntegrationStatuses`, `pickStatus`,
  `pillStateFor`, `IntegrationErrorMessage`) all live in one
  file. Pairs naturally with H-3's recommendation: extract
  `<IntegrationCard>` and split each integration's card into its
  own file.
- **Recommendation:** Same as H-3 — under
  `src/components/settings/integrations/{index, withings-card,
mood-log-card, integration-card}.tsx`.
- **Ship-blocker?** No.

### L-3 — `health-chart.tsx` is 1360 lines

- **Severity:** LOW (pre-existing, not v1.4.19's regression)
- **File:** `src/components/charts/health-chart.tsx` (1360 lines)
- **Issue:** Largest user-authored file outside generated Prisma
  client and `insights/page.tsx`. v1.4.19 added two imports + ~12
  lines for the tick-density wiring; the file's growth is owed
  to earlier milestones.
- **Recommendation:** Defer; not a v1.4.19 issue.
- **Ship-blocker?** No.

### L-4 — `formatTokenName` uses UTC accessors on a Berlin-timezone product

- **Severity:** LOW (correctness-adjacent, not architectural)
- **File:** `src/components/admin/api-token-overview-section.tsx:69-82`
- **Issue:** Uses `getUTCDate()` / `getUTCMonth()` / `getUTCHours()`
  to render the embedded ISO timestamp on auto-issued token
  names (`web auto-login 2026-05-05T19:46:20.603Z` → `web
auto-login · 05.05.2026 19:46`). Marc's project default is
  Europe/Berlin display, UTC storage. A token issued at 19:46
  Berlin in winter renders as 18:46. Other admin surfaces use
  `formatDate()` / `formatDateTime()` from `@/lib/format`, which
  handle the timezone correctly. Naming-consistency lens: this
  is a custom date formatter parallel to the canonical
  `format.ts` helpers, with different output rules
  (DD.MM.YYYY HH:MM hard-coded German order).
- **Recommendation:** Pass the parsed `Date` through `formatDate()`
  - `formatDateTime()` from `@/lib/format`, or extract a
    `formatBerlinDateTimeShort()` shared helper. Hand the
    correctness call to code-reviewer.
- **Ship-blocker?** No.

### L-5 — Telegram badge collapse uses bullet-point string concat instead of single i18n key OR pill

- **Severity:** LOW
- **File:** `src/components/settings/telegram-card.tsx:121`
- **Issue:** F-16 collapse pattern is
  `{t("settings.configured")} · {t("common.disabled")}` — string
  concatenation across two i18n keys joined with a literal `·`.
  Works for EN+DE but is the kind of pattern the i18n integrity
  test (`src/lib/__tests__/i18n-locale-integrity.test.ts`)
  cannot guard. Also: this is the same use case
  `IntegrationStatusPill` was built for in A5 (single chip with
  state + supplementary text), but the Telegram card uses an
  ad-hoc Badge instead.
- **Recommendation:** Either add a single
  `settings.telegramConfiguredButDisabled` i18n key (one
  insertion in EN+DE), OR — preferred — reuse
  `IntegrationStatusPill` with a new `state="paused"` variant.
  Aligns Telegram's status presentation with Withings + MoodLog.
- **Ship-blocker?** No.

### L-6 — `getViewportWidth()` SSR fallback hardcodes 1280

- **Severity:** LOW (defensiveness)
- **File:** `src/lib/charts/x-axis-density.ts:96-99`
- **Issue:** Returns `1280` as the SSR default. Reasonable choice
  but unmotivated by a constant — anyone tweaking the desktop
  threshold has to remember the SSR fallback exists. The bucket
  thresholds at the top of the file (360/480/768/∞) live in a
  table; the fallback should ideally read `1280` from the same
  source of truth.
- **Recommendation:** Optional — declare
  `const SSR_DEFAULT_VIEWPORT_WIDTH = 1280;` in a comment-anchored
  block referencing the bucket table.
- **Ship-blocker?** No.

### L-7 — A1 windows naming verified coherent (no finding, just confirmation)

- **Severity:** N/A (verified clean)
- **File:** `src/lib/analytics/bp-in-target.ts:215-249`
- **Verdict:** The brief's question 6 — "windows.last30Days vs
  windows.allTime pattern coherent" — is **YES, coherent**. All
  three keys follow camelCase. All three return the same shape
  (`{ pct: number; pairs: number } | null`). All three semantics
  are documented in the function header. The analytics route
  mapping (`bpInTargetPct ← allTime`, `bpInTargetPct7d ←
last7Days`, `bpInTargetPct30d ← last30Days`) is unambiguous
  and tested.

### L-8 — A7's "AdminShell tweak" was NOT generalized — local fix only

- **Severity:** LOW (informational, no defect)
- **File:** `src/components/admin/api-token-overview-section.tsx`
- **Verdict:** The brief's question 4 — "AdminShell tweak (hide
  collapse on single-section pages) generalized correctly?" — is
  **moot**. There was no AdminShell tweak in v1.4.19. Commit
  `7a70db6` removed the local `useState<expanded>` from
  `ApiTokenOverviewSection` only. The AdminShell itself
  (`src/components/admin/admin-shell.tsx`) is untouched at
  v1.4.18 content. `LoginOverviewSection` still carries its own
  `settings.collapse` / `settings.expand` toggle (the i18n keys
  were left in place specifically because LoginOverview still
  uses them). This is the correct call: `/admin/api-tokens`
  renders exactly one card → no collapse needed;
  `/admin/login-overview` is dense with filters + table →
  collapse still earns its keep.
- **Recommendation:** None.
- **Ship-blocker?** No.

---

## TODO/FIXME inventory (v1.4.19 changed files)

`grep -nE "(TODO|FIXME|XXX|HACK)"` across files in
`git diff --name-only v1.4.18...HEAD | grep -E "\.(ts|tsx)$"`
returns:

```
src/lib/__tests__/i18n-locale-integrity.test.ts:313 — comment in test
                                                       asserting NO TODOs
src/lib/__tests__/i18n-locale-integrity.test.ts:320 — regex used by
                                                       the assertion
src/lib/__tests__/i18n-locale-integrity.test.ts:326 — failure message
                                                       string
```

**Net new TODO/FIXME/XXX/HACK in production code:** zero. The
three matches above live inside a guard test that asserts
production code stays clean.

---

## Cross-cutting checks

- **A2 charts module growth (Q1):** Logical layering, not
  scattered. New `src/lib/charts/x-axis-density.ts` (100 lines)
  is pure & deterministic — `resolveTargetTickCount`,
  `chooseTickInterval`, `getViewportWidth` — plus a co-located
  unit test. The reactive `useViewportWidth()` hook
  (`src/hooks/use-viewport-width.ts`, 35 lines) is a thin SSR-safe
  wrapper around the pure helper. The four chart wrappers
  (`HealthChart`, `MoodChart`, `MedicationComplianceChart`,
  `ComplianceLineChart`) all consume both with the same import
  pattern. Scatter chart deliberately excluded (numeric x-axis
  with explicit `ticks` array) — documented choice. **Verdict:
  correct layering, ship as-is.**

- **A5 IntegrationStatusPill (Q2):** Right level of abstraction.
  Component (135 lines) is single-purpose, locale-aware, mobile-
  safe, and tested in isolation. Currently only consumed by
  `WithingsCard` + `MoodLogCard` (two callsites) but the brief
  itself plus the A5 report indicate Apple Health (v1.5) will
  also consume it. **NOT premature** — the brief explicitly
  builds for the third future caller. The premature abstraction
  here would be the OPPOSITE direction: see H-3, where the
  _card chrome around the pill_ should also have been
  extracted — but a tactically-narrow extraction (just the
  pill) is justifiable for v1.4.19's scope.

- **A6 settings input height (Q3):** Single source of truth is
  the value `36 px` (= Tailwind `h-9`), tracked via a
  documentation comment ("the shared 36-px input contract used
  everywhere else in Settings") rather than a CSS variable or
  shared class string. The `NATIVE_SELECT_CLASS` constant
  introduced in account-section centralises the _native select_
  styling (12 visual tokens) — but only within that file. AI
  section's three `<select>` elements were converted to
  `h-9` inline. So: the **rule** is single-source (everything is
  36 px), but the **rule's implementation** is repeated across
  three files (account-section, ai-section,
  dashboard-layout-section) as either inline `h-9` classes or a
  local constant. For a 3-file change this is fine; for the
  cleanup commit alongside H-1/H-2/H-3, consider promoting
  `NATIVE_SELECT_CLASS` to `src/components/ui/native-select.tsx`
  (a `<select>` wrapper that styles itself like `<Input>`). Not
  a v1.4.19 ship-blocker.

- **A7 admin polish (Q4):** See L-8. AdminShell wasn't actually
  touched. The "single-section page" decision was made locally
  per-section, which IS the correct call (one section's collapse
  semantics shouldn't dictate another's).

- **A8/Wave B 27 fixes (Q5):** Three real anti-patterns surfaced
  — H-1 (`lang={locale}` ×14), H-2 (`AUTH_ACTION_LABELS` ×2),
  L-5 (Telegram pill ad-hoc instead of reusing
  IntegrationStatusPill). No defensive null-checks introduced
  (verified: zero new `?? null` / `?.` patterns wrapping
  values that are typed non-nullable). Translation key additions
  (auth.token.\* ×3) correctly land in both EN+DE per the project
  i18n integrity rule.

- **A1 BP-status windows (Q6):** Verified coherent. See L-7.

---

## Overall verdict

- **Zero ship-blockers.** v1.4.19 introduced no anti-pattern
  severe enough to block release.
- **Zero CRITICAL.** Zero HIGH that are correctness-impacting; all
  three HIGH findings are hygiene / drift-trap.
- **Three HIGH** (H-1 lang= copy-paste, H-2 AUTH_ACTION_LABELS,
  H-3 integration card chrome).
- **Five MEDIUM** (M-1 chart-header dedup, M-2 time-ranges
  constant, M-3 memoisation, M-4 filter rule single-source, M-5
  advisor-card branch consolidation).
- **Eight LOW** (three are pre-existing file-size watchpoints
  that v1.4.19 didn't worsen; one is a perf-watch on
  `findClosestDia`-style scans inside the dataset; the rest are
  hygiene).
- Two questions in the brief resolved cleanly:
  - Q4 AdminShell tweak: there was no AdminShell tweak (L-8
    verdict). The fix was correctly local to one section.
  - Q6 BP-windows naming is coherent (L-7 verdict).

Recommend H-1, H-2, H-3 land as a focused "settings + admin
abstraction sweep" follow-up commit either pre-tag (low risk —
all three are mechanical extractions with vitest coverage
already in place) or as the first batch in v1.4.20's bucket A.
