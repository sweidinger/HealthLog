# Phase 4b — Admin Panel refactor report

Status: done. 9 atomic commits, `pnpm typecheck`, `pnpm lint` (warnings
only, all pre-existing), `pnpm test --run` (96 files / 745 tests) all
green. `pnpm format:check` flags two pre-existing planning reports
owned by Phase 3/4 — not touched by this phase.

## Scaffolding (commit `d8b71b3`)

`src/components/admin/section-slugs.ts` declares the 11-slug enum
(`system-status`, `general`, `services`, `integrations`, `feedback`,
`reminders`, `users`, `api-tokens`, `login-overview`, `backups`,
`danger-zone`) plus the legacy-anchor → slug map. The shell at
`src/components/admin/admin-shell.tsx` mirrors `<SettingsShell>`: mobile
horizontal scroll strip, desktop sticky 220px sidebar with an "Overview"
entry pointing back to `/admin`. Dynamic route at
`src/app/admin/[section]/page.tsx` is a server component that calls
`generateStaticParams()` and delegates to a client renderer in
`renderer.tsx`. The renderer's `switch` carries an `_exhaustive: never`
guard so a future slug added to the enum without a wired component is
caught at type-check time.

## Section relocation + overview reduction (commit `12b280b`)

Every existing component (`SystemStatusSection`, `GeneralSettingsSection`,
`ServicesSection`, `UmamiSection`, `GlitchtipSection`,
`WebPushVapidSection`, `BugReportSection`, `FeedbackInboxSection`,
`RemindersSection`, `UserManagementSection`, `ApiTokenOverviewSection`,
`LoginOverviewSection`, `DangerZoneSection`) had its `id` prop made
optional so it works under the new dynamic route. The composite
`<IntegrationsGroupSection>` at
`src/components/admin/integrations-group-section.tsx` wraps the four
integration sub-sections under one `/admin/integrations` route. The
old monolithic `/admin/page.tsx` is now a true overview: status-card
grid + a quick-jump menu of the 11 sections.

## Backups (commit `69c5225`, T2.6)

`GET /api/admin/backups` returns metadata-only DataBackup rows
(username, type, byte size, createdAt — never the encrypted blob).
`POST /api/admin/backups/run` enqueues an ad-hoc `data-backup` pg-boss
job using the global boss instance from `boss-instance.ts`; returns
503 if the worker isn't running. `<BackupsSection>` lists rows in a
table with size pretty-printed (B/KB/MB) and a "Backup now" button
that surfaces a sonner toast.

## Users management (commit `5957e18`, T2.7)

`<UserManagementSection>` now has filter pills (All / Admins / Users)
and a per-row force-logout action behind an `<AlertDialog>`
confirmation. The "suspended" filter from the original spec was
mapped to `all` because the User model has no `suspended` field
today — documented in a comment in `user-management-section.tsx` for
forward compatibility. `POST /api/admin/users/[id]/force-logout`
deletes every Session row for the target and writes
`admin.user.force-logout` to the audit log. Rejects self-target via
the `disabled` flag on the row button.

## i18n (commit `a34cd8c`)

`admin.shell.{overview,sectionsNav}` plus
`admin.section.<slug>.{title,subtitle}` for every slug, `users.filter.*`
for the filter pills, and the new force-logout / backups copy. EN
canonical, DE mirrors. The existing `i18n-locale-integrity.test.ts`
already enforces parity at PR time — no new test was needed.

## Sidebar nav (commit `73965cd`)

`src/components/layout/sidebar-nav.tsx` now reads `useAuth()` to
conditionally render an "Admin Console" entry between Bug Report and
Settings. When the active route starts with `/admin/`, the entry
expands into an indented sub-list of every section (collapsed-mode
keeps the icon-only button without the sub-list).

## Status-card hrefs (commit `961e2a9`)

Every CTA in `status-card-grid.tsx` switched from `/admin#section-*` to
`/admin/<slug>`. The honesty problem from v1.4.6 T6 is permanently
fixed.

## Legacy redirects (commit `7a47532`)

`proxy.ts` adds `LEGACY_ADMIN_ANCHORS`, a 13-entry 301 map from
`/admin/section-<id>` (path style) to `/admin/<slug>`. **Pure URL
fragments (`#foo`) never reach the server**, so the only legacy form
this phase can handle server-side is the path-style mistype. Every
in-app callsite has been rewritten to use the new route directly, so
no live link relies on the redirect — it's defence for hand-typed
bookmarks and referrer rewriters.

## Tests (commit `1a7e3d6`)

`status-card-grid.test.tsx` replaces the v1.4.6 anchor-id allowlist
with three checks per card: href matches `/admin/<slug>`, slug is in
`ADMIN_SECTION_SLUGS`, and `src/app/admin/[section]/page.tsx` exists
on disk via `existsSync`. New `sections.test.tsx` SSR-renders every
section component reachable from the renderer (uses `vi.mock` on
TanStack Query, the auth hook, and `next/navigation`) and asserts the
v1.5 fold-ins (filter pills, "Backup now" button) paint.

## Bundle-size verification

`pnpm build` aborts on the documented Node 25 `Cannot read private
member #state` regression (already noted in STATE.md). Static
inspection of the dependency graph confirms the win: `/admin/page.tsx`
now imports only `<AdminShell>`, `<StatusCardGrid>`,
`<ADMIN_SECTIONS>`, and `useAdminSettings`. The 13 section components
that previously lived in the monolithic page no longer ship in the
overview chunk; each is reachable only from its own dynamic-route
bundle.
