# Phase D — SIMPLIFY review (v1.4.19)

Reviewer: simplify-auditor (one of six parallel D-phase reviewers)
Scope: `git diff --name-only v1.4.18...HEAD` (~80 files, src + tests + i18n)
Tone: per CLAUDE.md — flag premature abstractions, defensive code that
can't fire, speculative options, what-comments, leftover shims, and
4+-callsite repetition. Empty list valid.

Findings ordered by impact. "Apply autonomously" = whether the smell
is mechanical enough to land without fresh design discussion.

---

## F1 — `AUTH_ACTION_LABELS` map duplicated verbatim across two admin sections

- **Files**:
  - `src/components/admin/login-overview-section.tsx:70-82`
  - `src/components/admin/recent-audit-preview.tsx:50-62`
- **Type**: Repetition (4+-callsite trigger met: 11 keys × 2 sites,
  both touched in the same v1.4.19 patch when the new `auth.token.*`
  rows landed)
- **Why it's a smell**: Identical 11-key `Record<string, string>` map
  built inline in two different components. v1.4.19 added three new
  keys (`auth.token.autoissue.native`, `auth.token.refresh`,
  `auth.token.revoke`); both files had to be edited in lock-step to
  pick them up. A fourth call site (e.g. an admin notification feed
  surfacing the same audit rows) would have to copy the same map a
  third time. The map is also constructed _inside_ the component on
  every render even though it depends only on `t` — every locale flip
  rebuilds the same 11-entry literal in two places.
- **Suggested change**: Extract once to `src/components/admin/_shared.tsx`:
  ```ts
  export function useAuthActionLabels(): Record<string, string> {
    const { t } = useTranslations();
    return {
      "auth.register": t("admin.authRegister"),
      // …
      "auth.token.revoke": t("admin.authTokenRevoke"),
    };
  }
  ```
  Both call sites become `const AUTH_ACTION_LABELS = useAuthActionLabels()`.
- **Risk**: Very low — pure rename + re-import; no behaviour change.
- **Apply autonomously?**: yes

---

## F2 — `chipClass` dead-assigned for two of three pill states

- **File**: `src/components/settings/integration-status-pill.tsx:79-98,121-125`
- **Type**: Dead code (defensive code that can't fire)
- **Why it's a smell**: The `error` and `disconnected` branches set
  `chipClass = ""` (lines 91, 96), but `chipClass` is only ever read
  inside `state === "connected" && chipClass` (line 123). Two
  assignments and the `let chipClass: string` declaration exist solely
  to keep the switch exhaustive — they paint nothing.
- **Suggested change**: Replace the local with a const inside the
  `connected` arm:
  ```ts
  const connectedChipClass =
    "border-dracula-green/30 bg-dracula-green/15 text-dracula-green";
  // …
  className={cn(
    "max-w-full whitespace-nowrap",
    state === "connected" && connectedChipClass,
    className,
  )}
  ```
  Drop `chipClass` from the switch entirely. (Keeping the switch for
  `label` + `icon` is fine — those are read in every state.)
- **Risk**: Trivial — purely cosmetic refactor, no rendered output
  changes. The existing pill test suite covers all three branches.
- **Apply autonomously?**: yes

---

## F3 — `lang={locale}` on every `<Input type="datetime-local">` /

`type="date"` — 14 callsites, no shared wrapper

- **Files (count: 14 callsites across 9 files)**:
  - `src/app/onboarding/page.tsx:307`
  - `src/components/settings/account-section.tsx:389`
  - `src/components/settings/export-section.tsx:266, 279`
  - `src/components/medications/intake-history-list.tsx:548, 562, 694, 708`
  - `src/components/mood/mood-list.tsx:575`
  - `src/components/mood/mood-form.tsx:138`
  - `src/components/measurements/measurement-form.tsx:364`
  - `src/components/measurements/measurement-list.tsx:590`
  - `src/components/doctor-report/doctor-report-dialog.tsx:197, 214`
- **Type**: Repetition (14 callsites, way past the 4+ threshold)
- **Why it's a smell**: v1.4.19 commit `ff6e184`
  ("hint browser locale on date and datetime inputs") sprinkled the
  same `lang={locale}` prop into every native date / datetime-local
  Input. The pattern is now _the_ convention — but it's expressed by
  hoping every developer remembers to add the prop, rather than by a
  primitive that bakes it in. A future date input that ships without
  `lang={locale}` will silently regress (the visual format is purely
  browser-controlled, no test fails).
- **Suggested change**: Add a thin `<DateTimeInput>` /
  `<DateInput>` wrapper in `src/components/ui/date-input.tsx`:
  ```tsx
  export function DateInput(props: Omit<InputProps, "type" | "lang">) {
    const { locale } = useTranslations();
    return <Input type="date" lang={locale} {...props} />;
  }
  ```
  Same for `DateTimeInput` with `type="datetime-local"`. Replace 14
  call sites mechanically. The prop sprawl from individually pulling
  `locale` out of `useTranslations` in 9 components disappears too.
- **Risk**: Low — wrapper is a 6-line drop-in. The 14 replacements
  are mechanical (`Input type="date"` → `DateInput`, drop the
  `lang={locale}` and the destructure where the only reason for `locale`
  was the prop). One nuance: 5 of the call sites also use `locale` for
  other things (medication card formatting, etc.) — leave those
  destructures alone.
- **Apply autonomously?**: yes (mechanical sweep with `grep`-driven
  replacements; tests already cover the broader form behaviour)

---

## F4 — Single-icon wrapper `<div>` left behind after card title removed

- **Files**:
  - `src/components/admin/feedback-inbox-section.tsx:81-83`
  - `src/components/admin/danger-zone-section.tsx:73-78`
  - `src/components/settings/thresholds-editor-section.tsx:129-134`
- **Type**: Dead code (post-removal scaffolding)
- **Why it's a smell**: Each of the three commits that dropped a
  duplicate card title kept the `<div className="flex items-center
gap-2">` wrapper, which now contains exactly one icon. The wrapper
  was there to align icon+title on the same row; with the title gone
  the flex/gap classes do nothing. Reads as scar tissue from the
  removal patch.
- **Suggested change**: Drop the wrapper, render the icon directly:
  ```tsx
  <Inbox className="text-primary h-5 w-5" aria-hidden="true" />
  ```
  Same for `<AlertTriangle>` (danger-zone) and
  `<SlidersHorizontal>` (thresholds-editor).
- **Risk**: Trivial — the spacing inside the card is governed by the
  parent `mt-4` / `space-y-4` / `space-y-5` already.
- **Apply autonomously?**: yes

---

## F5 — `metaSlot` prop on `<InsightsPageHero>` has exactly one caller

- **Files**:
  - `src/components/insights/insights-page-hero.tsx:43-53,127-135`
  - `src/app/insights/page.tsx:866` (only caller passing `metaSlot`)
- **Type**: Premature abstraction (single-callsite prop with
  speculative future-extensions framing in the JSDoc)
- **Why it's a smell**: The new `metaSlot?: React.ReactNode` prop
  exists solely to inject `<CompareToggle />` into the hero meta band
  on `/insights`. There is no second caller; the doc-string speculates
  about "page-level metadata slot". The `CompareToggle` could just as
  well be rendered as `children` (the hero already has structured
  content slots: generated/baseline/regenerate). Per CLAUDE.md
  "single-callsite helpers / single-implementation interfaces", this
  is the textbook case.
- **Suggested change**: Either (a) inline the toggle inside the hero
  for the single page that needs it, gated by a presence check on a
  more explicit prop (`showCompareToggle?: boolean`), or (b) accept it
  as an extra `<InsightsPageHero>` `children` slot with a
  data-slot rendering hook. Option (a) is simpler given there's
  exactly one caller; revisit if a second page needs the same band.
- **Risk**: Low — the change is in one component + one caller. Tests
  for `<InsightsPageHero>` already use the prop sparingly (no
  fixtures pass `metaSlot`).
- **Apply autonomously?**: no — design call (which prop shape is the
  right one) belongs to the next planning round, not a mechanical
  sweep.

---

## F6 — Speculative permissive `STRIP_TOKEN_REGEX` for hypothetical

hallucinations

- **File**: `src/lib/insights/chart-tokens.ts:42-55`
- **Type**: Speculative-options option (defending against patterns
  the AI might emit, with one verbatim-Marc anecdote as evidence)
- **Why it's a smell**: A3 split a single `metric:[A-Z_]+` regex into
  a permissive strip-side (`metric:[A-Za-z0-9_]+`) and a strict
  parse-side. The justification ("Marc 2026-05-10:
  `metric:blood_pressure_sweet_spot`") is one anecdote; the comment
  speculates lowercase / digit / snake_case tokens "leak to the DOM"
  but the token allowlist filter happens before render, so the only
  real failure mode is the literal token string leaking into prose.
  Worth keeping if AI prose actually leaks lowercase tokens in
  non-trivial frequency, but the comment treats it as a permanent
  hardening when the test suite has only one regression test
  (`stripChartTokens` tests at `chart-tokens.test.ts`). The two-regex
  setup means future allowlist changes need to be cross-checked
  against both patterns.
- **Suggested change**: Verify whether prose emissions of `metric:lowercase…` are still happening in v1.4.19 advisor outputs (sample
  recent payloads from prod). If not, collapse back to the single
  uppercase regex and re-add the permissive strip only when a fresh
  regression appears. If still happening, leave the split but trim
  the verbose 12-line comment to the 2-line "why two regexes" gist.
- **Risk**: Medium-low — needs an empirical check before reverting;
  the strict-parse path is correct either way (allowlist filters), so
  the worst case of premature collapse is a literal token leaking
  into UI prose for a few days.
- **Apply autonomously?**: no — wants a quick prod-payload sample
  before the call.

---

## F7 — `formatBackupType` / `formatMeasurementSource` are

near-clone enum-translate helpers

- **Files**:
  - `src/components/admin/backups-section.tsx:160-170`
  - `src/components/measurements/measurement-list.tsx:107-122`
  - (Also similar shape in
    `src/components/medications/intake-history-list.tsx:99-105` —
    `sourceLabels` lookup in-component)
- **Type**: Repetition (3 callsites; below the 4+ threshold but worth
  noting because v1.4.19 added two of them in the same wave)
- **Why it's a smell**: Both helpers do the same job: take a
  SCREAMING_SNAKE enum string + the i18n `t` function, look up
  `t(...key)` for known values, fall back to the raw string. v1.4.19
  Wave-B added these two in the same patch (both were "humanise raw
  enum badges" fixes). The pattern is genuine but the shape is
  per-enum because the i18n key prefix differs.
- **Suggested change**: Leave alone for now — only 3 call sites and
  the `t` keys differ per enum, so a generic helper would have to
  take the prefix as an argument and gain nothing in line count.
  Re-evaluate when a 4th appears (likely candidates: `IntakeStatus`,
  `NotificationChannel`).
- **Risk**: n/a (the suggestion is "no action").
- **Apply autonomously?**: n/a

---

## F8 — Verbose post-removal "v1.4.19 X removed because …" comments

- **Files**:
  - `src/app/insights/page.tsx:226-232` (`getRangeColorClass` /
    `getRangeHint` removal note)
  - `src/app/insights/page.tsx:648-651` (`bf` / `showBodyFatCard`
    removal note)
  - `src/app/insights/page.tsx:856-861` (compare-toggle move note)
  - `src/app/insights/page.tsx:868-880` (`onRegenerate` deletion
    note)
  - `src/app/page.tsx:494-503` (compare-toggle removal-from-dashboard
    note)
- **Type**: WHAT-not-WHY scarring / narration of past commits
- **Why it's a smell**: Five different comments in two files
  describe what _used to be there_ in v1.4.18 and why it was removed
  ("`bf` / `showBodyFatCard` … were bookkeeping for the now-removed
  duplicate tile strip", etc.). The git log + the v1.4.19 phase
  reports already record this. A fresh contributor reading the
  insights page does not need to know there used to be a tile strip
  there. Once these notes age past v1.4.20 they read as "history of
  the file" rather than "current invariants".
- **Suggested change**: Strip all five paragraphs. Replace with a
  single one-line `// see .planning/phase-A3-report.md` if a
  pointer is desired, or delete outright since `git blame` answers
  "what changed in v1.4.19". Keep only the comments that describe
  current invariants (e.g. the `pillStateFor` collapse comment in
  integrations-section is fine — that one explains current
  behaviour).
- **Risk**: Trivial — pure comment removal.
- **Apply autonomously?**: yes

---

## Cleanup verifications (no findings)

- **A5 `IntegrationStatusPill`** — 2 callsites today (Withings,
  Mood Log) plus a documented v1.4.20 plan to add Apple Health.
  Above the single-callsite threshold; passes the abstraction-bar
  per CLAUDE.md. **Clean.**
- **A2 `useViewportWidth` + `chooseTickInterval`** — used by 4 chart
  components (health, mood, compliance-line, medication-compliance)
  and the helper has its own unit-test suite. 4 callsites = right at
  the threshold, justified. **Clean.**
- **A1 `computeBpInTargetWindows` `allTime` window** — was the
  fix-the-headline change. The previous v1.4.18 review (F3) flagged
  the duplicate `computeBpInTargetPct` + `computeBpInTargetWindows`
  call in the analytics route; v1.4.19 went the _other_ direction
  and routed all three values through the windows helper, so the
  redundancy is now resolved. **Clean — no further action.**
- **A8 / Wave-B copy fixes** — 27 commits, mostly `messages/{de,en}.json`
  - small per-file edits. Spot-checked five files; no near-duplicate
    fixes that should share a helper. The two enum-translate helpers
    (F7) sit at 3 call sites, below threshold. **Clean.**
- **A7 admin scrollbar / collapse fixes** — `tabs.tsx` got the
  `overflow-y-hidden` clamp once + a single regression test. The
  `api-token-overview-section` collapse-button removal didn't leave
  any dead `expanded` state or `setExpanded` calls (verified by
  reading the post-fix file end-to-end). **Clean.**
- **`pillStateFor`** — single-purpose API-state→pill-state collapsor
  inside `integrations-section.tsx`. 2 call sites in the same file,
  pure function, ~7 lines. Could be inlined but is more readable as
  a named helper. Out of scope.

---

## Tally

- 5 actionable autonomous-safe findings (F1, F2, F3, F4, F8).
- 1 design-discussion finding (F5 — single-callsite `metaSlot`).
- 1 wants empirical evidence first (F6 — split chart-token regex).
- 1 informational no-action (F7 — enum-translate near-clones).
- 0 architectural rewrites required.

done: 5 apply-yes, 2 apply-no
