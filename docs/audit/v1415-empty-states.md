# v1.4.15 — Empty-states audit

Date: 2026-05-09
Owner: Phase C5 agent (parallel with C1 + C4).
Primitive: `src/components/ui/empty-state.tsx` (already shipped earlier
in v1.4.15; sweep below tracks adoption).

The audit walks every list / table / tile surface a brand-new user
hits, classifies the empty path, and records the fix. "Useful" means
icon + title + description + (where it makes sense) a primary action,
not a single grey sentence floating in a card.

## Findings

| Route / surface | Component | State before | What was wrong | What changed |
| --- | --- | --- | --- | --- |
| `/admin/users` | `UserManagementSection` | Loading-only — when `users` resolved to `[]` the table simply rendered an empty `<tbody>` with the header still visible. | Empty case never specified; on a fresh deployment with one admin self-row it never reproduced for Marc, but the `admin/user` filter did regularly. | New `<EmptyState>` mounts inside the card when `filteredUsers.length === 0`, with `Users` icon, filter-aware copy, and a "Reset filter" CTA when a filter is active. |
| `/admin/backups` | `BackupsSection` | Plain `<p>No backups recorded yet.</p>`. | No icon, no CTA, no signal that the "Run backup now" button at the top is what to click. | Replaced with `<EmptyState>` (`Database` icon) that includes a primary "Backup now" button — duplicates the header CTA but inside the empty card so the new admin doesn't need to look up. |
| `/admin/login-overview` | `LoginOverviewSection` | Plain `<p>No entries found.</p>` (filter-dependent). | When "Failed only" is selected on a healthy installation the user sees nothing — looked like a bug. | `<EmptyState>` with `ScrollText` icon, filter-aware description, and a "Show all events" CTA when the failed-only filter is active. |
| `/admin/api-tokens` | `ApiTokenOverviewSection` | Plain `<p>No API tokens found.</p>`. | Doesn't tell admins that tokens are issued at login from native clients — they wonder if they need to create them somewhere. | `<EmptyState>` with `Key` icon and a description pointing to native sign-in / Settings → Account API tokens. |
| `/admin/feedback` | `FeedbackInboxSection` | Plain `<p>No feedback in this category.</p>` per tab. | OK as text but the tab strip already shows `0` badges; the inner panel deserves the same compactness as other admin sections. | `<EmptyState size="compact">` with `Inbox` icon. Per-tab description. |
| `/admin` overview | `RecentAuditPreview` | Plain `<p>No recent audit entries.</p>`. | Compact but icon-less — visually inconsistent with the audit-table fixes. | `<EmptyState size="compact" variant="plain">` with `ScrollText` icon. |
| `/measurements` | `MeasurementList` | `<div class="border-dashed">{t("measurements.noMeasurements")}</div>`. | No CTA and the top-level "Add measurement" button is the only way out. | `<EmptyState>` with `Activity` icon, filter-aware description, "Add your first measurement" CTA. |
| `/mood` | `MoodList` | `<div class="border-dashed">{t("mood.noEntries")}</div>`. | No CTA. | `<EmptyState>` with `Smile` icon, filter-aware description, "Log your first mood" CTA. |
| `/medications` | `MedicationsPage` | Custom inline icon + button block. | Already friendly but didn't share the new primitive — diverging styles. | Refactored to `<EmptyState>` with `Pill` icon, "Add first medication" CTA. Visual parity with the rest. |
| `/insights` (top-level) | `InsightsPage` | Plain `<div class="text-muted-foreground py-20 text-center">{t("common.noData")}</div>` when `data` is undefined. | Looked like a hung page. | `<EmptyState>` with `TrendingUp` icon, "Log a measurement" CTA → `/measurements`. |
| `/insights` (BMI no-height) | Inline `<p>` | "no data" when `user.heightCm == null`. | The user might wonder why the BMI section is empty. | `<EmptyState size="compact" variant="plain">` with `Ruler` icon, copy points to `/settings/account` and a "Set height" CTA. |
| `/achievements` | `AchievementsPage` (no-grouped state) | Plain `<p>No achievements unlocked yet.</p>` inside a card. | Icon-less. The card after summary tiles needs the same visual cue we use elsewhere. | `<EmptyState>` with `Trophy` icon — keeps the same `noneUnlockedYet` string to avoid C4 i18n churn. |
| Dashboard tile-strip / charts | `DashboardPage` | Tile strip + chart row both hidden when every metric has zero data; only `<GettingStartedChecklist>` plus the welcome banner show. The strip itself stays a 0-px row. | Brand-new users see a near-blank page below the welcome banner — feels broken even though the checklist is technically present. | New `<EmptyState>` block rendered when `trendCards.length === 0 && charts.length === 0`. Routed to "Add your first measurement" via the existing quick-entry dialog (no nav). Does not race the checklist (which has its own self-gating). |

## Out of scope (deferred)

- `/insights` correlation-card empty branches (`scatterData.length < 5`)
  already use a custom in-card empty surface (icon + 2 lines) that's
  tighter than the generic primitive — refactor would only churn
  classes, no UX win. Leave for v1.4.16 if C4 i18n sweep wants the
  consistency.
- `/admin/danger-zone` and `/admin/services` are not lists — irrelevant.
- `/admin/system-status` shows operational data not user records —
  empty paths handled by per-card "—" + status text.
- `/admin/reminders` is a settings form, not a list.
- Dashboard `/insights` BMI `<p>{t("common.noData")}</p>` for a user
  with height but no weight is intentionally minimal — the chart
  itself shows the empty axis.
- Tab strip `0` badges on `/admin/feedback` use the same `<EmptyState
  size="compact">` per panel; not duplicating in this audit.

## Tests added

- `src/app/__tests__/measurement-list-empty.test.tsx` — confirms
  `<EmptyState>` renders with the "Log your first measurement" CTA on
  a fresh account (mocked TanStack Query result of
  `{ measurements: [], meta: { total: 0 }}`).
- `src/components/admin/__tests__/users-section-empty.test.tsx` —
  confirms the user-management empty state renders the filter-aware
  description and a "Reset filter" action when the admin filter is
  active.
- `src/components/admin/__tests__/backups-section-empty.test.tsx` —
  confirms the backups empty state surfaces the secondary "Backup
  now" CTA inside the empty card.
- Existing `src/components/ui/__tests__/empty-state.test.tsx` covers
  the primitive (4 variants).

## Counts

- **Empty-states added or upgraded**: 13.
  - admin sub-routes: 6 (users, backups, login-overview, api-tokens,
    feedback, overview-preview).
  - feature lists: 4 (measurements, mood, medications, achievements).
  - insights: 2 (top-level no-data, BMI no-height).
  - dashboard: 1 (tile-strip + charts both empty).
- **i18n keys added**: 18 in EN + DE under
  `emptyStates.*` (1), `measurements.empty.*` (4),
  `mood.empty.*` (4), `medications.empty.*` (3),
  `admin.section.users.empty.*` (3), `admin.section.backups.empty.*`
  (2), `admin.section.login-overview.empty.*` (3),
  `admin.section.api-tokens.empty.*` (2),
  `admin.section.feedback.empty.*` (2),
  `admin.overview.auditEmpty*` (1 reuses existing key + new
  description),
  `insights.empty.*` (3),
  `dashboard.empty.*` (3),
  `achievements.empty.*` (reuses `noneUnlockedYet`).
- **No new dependencies**.

## Verification

- `pnpm test` after each commit (target: 0 regressions).
- `pnpm typecheck` after each commit.
- `pnpm lint` after each commit.

## Reference

Phase C5 work order: `.planning/STATE.md` § Phase C5.
Primitive intro PR: see git log for `feat(ui): generic EmptyState
primitive` (already on `main` before this phase started — section 1 of
the C5 brief satisfied without a new commit).
