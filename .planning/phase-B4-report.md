# Phase B4 — Admin logs visibility deepening (v1.4.16)

Status: complete
Date: 2026-05-10T00:11+02:00
Commits on origin/main:

- `8ac5602` (audit-log filtering, pagination, CSV export — bundled with
  the Wave-A verification-gate planning commit due to the marathon
  coordinator's stash race; my code, wrong commit subject)
- `4cc3d8d feat(admin): app-log preview surfaces last 1h of structured events with filter + JSON inspector`
- `6520ae4 feat(admin): sidebar entry for app-logs`

## Scope delivered

### 1. Audit-log enhanced filtering, pagination, CSV export

`<LoginOverviewSection>` is now the deeper viewer admins asked for. It
keeps the failed-only quick-pill from the v1.4.x UI and stacks the new
filter row on top: actor (matches userId OR `user.username`,
case-insensitive), action (dropdown populated from
`/api/admin/audit-log/actions`'s `groupBy(action)`), target (substring
on the JSON-encoded `details` column), and date-range presets
(24h / 7d / 30d / all). Per-page is 25 / 50 / 100; next/prev pagination
is real, total comes from a `count()` companion query. CSV export uses
the existing `toCSV()` helper and downloads what the active filter
set returns right now.

`GET /api/admin/audit-log` learned the `actor` / `action` / `target` /
`since` / `until` / `page` / `perPage` query params. Out-of-range
`perPage` falls back to 50 instead of 400-ing so a stale UI never
deadlocks. Legacy `limit` / `offset` / `filter=auth` callers
(`<RecentAuditPreview>`, the failed-only pill) are unchanged.

9 unit tests pin every filter and the pagination contract; 1 covers
the actions endpoint.

### 2. App-log preview surfaces last 1h of structured wide-events

New `src/lib/logging/in-memory-buffer.ts` — 500-entry FIFO ring
buffer, hooked into `transports.emitEvent()`. Mirrors what would ship
to Loki (sampler-gated). Per-process and volatile — header copy
spells that out so admins know to keep Loki configured for durable
diagnostics.

`GET /api/admin/app-logs` reads the buffer with `traceId` / `level` /
`action` / `since` / `until` / `limit` filters, runs every event
through `redactSecrets()` on egress so a stray Bearer / hlk\_ / sk-
token in `error.message` never leaks to the admin UI; storage stays
raw to keep the diagnostic value when shipped to Loki.

`<AppLogPreviewSection>` lives at the new `/admin/app-logs` route —
table of recent events (level icon / timestamp / action / duration /
trace short-id), click row → JSON-pretty-print modal, 30s refetch.
Mirrors the per-section pattern v1.4.16 A1 established.

### 3. Sidebar entry

`<AdminShell>` gains the `app-logs` row with a `FileText` icon. The
global sidebar still surfaces a single `/admin` link per the v1.4.15
A1 + v1.4.16 A1 conditional pattern — per-section nav stays inside
the shell.

### 4. i18n

`admin.section.auditLog.*` (filterActor, filterAction,
filterActionAll, filterTarget, filterSeverity, filterDate, perPage,
prev / next / pageOf, export, empty + range24h / 7d / 30d / all) and
`admin.section.app-logs.*` (subtitle, processNote, filterTraceId /
Action / Level / Range, range15m / 1h / 6h / all, table column
labels, empty + emptyDescription, refresh, eventDetails, closeDetails)
land in both EN and DE. Locale-integrity guard stays green.

## Coordination friction

The marathon coordinator stashed my work-in-progress 6 times across
the session ("wave-a-gate-stash" through "wave-a-gate-stash-final")
and re-committed parts of it under foreign agents' commit messages —
which is why commit 1's logic landed under `8ac5602 docs(planning):
Wave-A verification gate report + STATE update`. Code is verbatim
what B4 wrote; only the commit subject drifted. Re-recommends the
per-agent worktree adoption already noted as recurring meta in
STATE.md from v1.4.15.

## Verification

- `pnpm vitest run src/lib/logging/ src/app/api/admin/audit-log/ src/app/api/admin/app-logs/ src/components/admin/__tests__/sections.test.tsx` — 51 / 51 green
- `pnpm typecheck` — 0 B4 errors (the typecheck failures present are
  sibling B7 broken endpoint paths)
- `pnpm lint` — 0 errors / 12 pre-existing warnings (none on B4 files)
