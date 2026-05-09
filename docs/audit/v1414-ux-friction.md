# v1.4.14 UX friction audit (Phase 5)

**Date:** 2026-05-09
**Method:** Static code walkthrough of the canonical user journey:
login → dashboard → add measurement → view insights → admin overview →
admin users → admin backups → settings/integrations → settings AI →
logout. Phase-3 e2e fixtures were referenced for behavioural details
already covered there; the local Node-25 build issue (documented in
`STATE.md`) prevented running Playwright as the audit driver, so this
list comes from reading the rendered components and route handlers.

Severity: **CRITICAL** ships tonight, **HIGH** ships tonight if scoped,
**MEDIUM/LOW** parked for v1.4.15 unless a bigger v1.4.14 audit batches them.

## Top friction points

### 1. **MEDIUM** — Dashboard quick-add menu items both said "Add"

- File: `src/app/page.tsx:380`, `src/app/page.tsx:384`.
- Symptom: the dropdown trigger says "Add" and both menu items
  underneath also rendered the literal "Add" (because
  `measurements.addMeasurement` and `mood.addEntry` both translate to
  the bare verb). Phase-3's `measurement-flow.spec.ts` worked around it
  with `getByRole("menuitem").first()`. Screen-reader users heard two
  indistinguishable rows.
- **Fixed tonight** — added `dashboard.quickAddMeasurement` /
  `dashboard.quickAddMood` keys (EN + DE) and labelled the menu items
  by what's being added ("Measurement" / "Mood entry"). e2e spec now
  targets by name.

### 2. **HIGH** — Missing "Remove saved key" CTA in `/settings/ai`

- File: `src/components/settings/ai-section.tsx`.
- Symptom: once an OpenAI / Anthropic / Local key was saved, the only
  way to clear it was to type a different key over the placeholder.
  Users couldn't fall back to the admin/Codex provider without a
  workaround.
- **Fixed tonight** — see commit `feat(settings): allow removing saved
AI provider key`.

### 3. **HIGH** — `/admin/users` icon-only buttons missed accessible names

- File: `src/components/admin/user-management-section.tsx`.
- Symptom: the per-row Edit / Reset password / Force-logout buttons
  rendered only an icon. `title` is acceptable as a fallback per HTML
  spec but axe-core flags it as a sub-optimal source. Tab order also
  produced repeated tooltip-only labels.
- **Fixed tonight** — added explicit `aria-label`, set the leading icon
  `aria-hidden`. Part of the a11y commit.

### 4. **HIGH** — `<PasswordInput>` toggle in admin/\_shared had no label

- File: `src/components/admin/_shared.tsx`.
- Symptom: the eye/eye-off button had no `aria-label`, hitting axe-core
  `button-name` (serious). Two copies of `<PasswordInput>` existed —
  the canonical one in `src/components/settings/password-input.tsx`
  was already fixed in phase-3.
- **Fixed tonight** — admin's copy now re-exports the canonical
  component. Part of the a11y commit.

### 5. **MEDIUM** — Trend-arrow colour was meaning-blind in v1.4.6

- File: `src/components/charts/trend-card.tsx`.
- Symptom: P4 of v1.4.6 stripped the colour because the original "up
  red, down green" rule was wrong for half the metrics (mood up =
  good, weight up = bad). The result was muted everywhere and lost
  visual signal.
- **Fixed tonight** — `directionSentiment` prop with three buckets
  (`up-good` / `up-bad` / `neutral`). All dashboard tiles wired. See
  commit `feat(ui): trend arrow color reflects metric-specific
direction sentiment`.

### 6. **MEDIUM** — Status-card audit-log row had an empty `<dd>`

- File: `src/components/admin/status-card-grid.tsx:220`.
- Symptom: the audit-log card filled its third metric slot with
  `{ label: "—", value: "" }`. Empty `<dd>` cells aren't navigable and
  are flagged by axe `definition-list`.
- **Fixed tonight** — dropped the placeholder; the 3-col grid keeps
  layout. Test updated.

### 7. **MEDIUM** — Feedback / mood / medication status used raw colours

- Files: `src/components/admin/feedback-inbox-section.tsx`,
  `src/components/medications/medication-card.tsx`,
  `src/components/settings/ai-section.tsx`.
- Symptom: `text-dracula-green` for "success" reads as a colour, not a
  meaning. Light mode (Alucard) failed AA contrast for raw Dracula
  greens / oranges on white cards.
- **Fixed tonight** — added semantic `--success` / `--warning` /
  `--info` tokens to `globals.css` (dark = Dracula alias, light =
  AA-contrast counterpart matching `--destructive`'s pattern). Migrated
  feedback BUG badge → `destructive`, "published to GitHub" badge →
  `success`, medication status (in-window → success, very-overdue →
  warning), AI section connection badges. See commit `style(ui): use
semantic tokens for mood and feedback indicators`.

### 8. **LOW** — Logout from `/settings` requires going to topbar

- Files: `src/components/layout/sidebar-nav.tsx`,
  `src/components/layout/top-bar.tsx`.
- Symptom: on desktop the sidebar's user-section dropdown carries
  Logout, but on mobile within `/settings/*` the topbar's user-menu is
  still the only path. Not broken, but the action is two interactions
  away from settings landing.
- **Deferred to v1.4.15** — would need a new "Sign out" surface in the
  Settings shell.

### 9. **LOW** — Insights section nav has no `aria-label`

- File: `src/app/insights/page.tsx:1604` (`<nav>` block).
- Symptom: the sticky horizontal section navigator inside `/insights`
  is rendered as `<nav>` without `aria-label`, so multiple nav landmarks
  on the page show up as "navigation, navigation, navigation" in screen
  reader landmark lists.
- **Deferred to v1.4.15** — needs an i18n key plus a check that the same
  `<nav>` doesn't already have one elsewhere on the page.

### 10. **LOW** — `/admin` overview "Sections" list has no aria-label

- File: `src/app/admin/page.tsx`.
- Symptom: the quick-jump grid below the status cards is wrapped in a
  `<ul>` but the parent `<div>` has no role/landmark. The sidebar nav
  already exists, so duplicating it as a quick-jump is fine, but the
  list could be wrapped in a `<nav aria-labelledby=...>` for parity
  with the sidebar.
- **Deferred to v1.4.15**.

## v1.4.15 backlog (from this audit)

- Dedicated Sign-out CTA in `<SettingsShell>` mobile mode.
- `aria-label` on `<nav>` landmarks across `/insights` and `/admin` overview.
- Broader semantic-token sweep (`telegram-card`, `ntfy-card`,
  `web-push-card`, `account-section`, `about-section`,
  `test-connection-button`) — same colour swap as feedback / AI / meds
  but bigger blast radius; needs a single-PR sweep.
- "Late" medication status uses `dracula-yellow` directly; once we have
  a `--caution` semantic token, swap that too.
- Insights long-page section navigator could grow a "back to top"
  button on mobile for one-handed reach.

## Method note

The local environment ran Node 25 which currently surfaces the
`Cannot read private member #state` Reflect.get bug in
`src/lib/api-handler.ts` (documented in `CLAUDE.md` and the v1.4.6
summary). That blocks both `pnpm build` and `pnpm dev`, so the
Playwright e2e suite couldn't drive the journey from this machine.
The reactivated `/admin` axe-core spec (`e2e/a11y.spec.ts`) and the
existing `measurement-flow.spec.ts` will validate the fixes once CI
runs on Node 22 (canonical CI version, see `.github/workflows/`).
