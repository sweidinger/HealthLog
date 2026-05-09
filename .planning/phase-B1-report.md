# Phase B1 — Backup completeness — report

Status: done · 2026-05-09T21:03+02:00

## Scope

The v1.4.14 admin Backups page only listed `DataBackup` rows + ran a
manual job. Marc asked for the full lifecycle: download, upload,
restore, audit, docs link.

## What landed

All five criteria are on `origin/main`:

| # | Criterion | Endpoint / file | Tests |
|---|-----------|-----------------|-------|
| 1 | Download backup as JSON | `GET /api/admin/backups/[id]/download` | 2 |
| 2 | Upload backup with schema validation | `POST /api/admin/backups/upload` | 5 |
| 3 | Restore from backup with full replacement | `POST /api/admin/backups/[id]/restore` | 3 |
| 4 | Audit-log all backup ops | `run/route.ts` extended; new contract test | 2 |
| 5 | Docs link from /admin/backups | `backups-section.tsx` | (visual) |

New shared module: `src/lib/validations/backup.ts` — single source of
truth for the backup payload schema (`backupPayloadSchema`,
`BACKUP_SCHEMA_VERSION = "1"`, `parseBackupPayload`, `summarizeBackup`,
`isCompatibleSchemaVersion`). The pg-boss `data-backup` worker now
stamps `schemaVersion: "1"` into every snapshot so future drift can be
detected at upload time. Older blobs default to `"1"` on parse.

Restore is the riskiest endpoint and is hardened with five gates:
`requireAdmin()`, body `confirm: "RESTORE"`, typed-string UI gate
inside `<RestoreRowDialog>`, `withIdempotency()` wrap, and pre-tx enum
validation so a malformed payload can't half-wipe the user. Restore
scope mirrors the v1.4.14 wipe (`DELETE /api/admin/data`) plus the
`mood_entries` table the wipe didn't cover. AuditLog rows are
preserved across restore.

Audit actions added (8 total new):
- `admin.backups.run`, `.run.denied`
- `admin.backups.download`, `.download.denied`, `.download.failed`
- `admin.backups.upload`, `.upload.denied`
- `admin.backups.restore`, `.restore.start`, `.restore.denied`,
  `.restore.failed`

i18n: 19 new keys under `admin.section.backups.*` in EN + DE.

## Verification

- Unit: 883 / 883 passing (was 879).
- Integration: 31 / 31 passing (was 19); new files
  `admin-backups-download.test.ts` (2), `admin-backups-upload.test.ts`
  (5), `admin-backups-restore.test.ts` (3), `admin-backups-audit.test.ts` (2).
- Typecheck: clean for B1 files. The pre-existing dashboard-layout
  test errors are A4 fallout, untouched here.
- Lint: 11 pre-existing warnings, no new errors.

## Cross-agent observation

Same shared-cwd / shared-index race that marred Phases A2 + A4:
sibling `git commit -a`-ish behaviour swept my staged files into
unrelated commits (criterion 1 absorbed by `d8c549e`, criterion 2 by
`30a74ed`, criterion 4 by `0805452`, criterion 5 partially by
`7c32d63` which I won but it picked up B3 untracked files). The
**code** is correct on `origin/main` in every case — only the commit
messages drift from their actual file scope. Criterion 3 (`fe85c2c`)
landed cleanly under its own message.

Recommendation for v1.4.16, echoing the STATE.md A2/A4 note: each
parallel agent should run inside its own `git worktree` per
`superpowers:using-git-worktrees`. The current shared `Working dir:
/Users/marc/Projects/HealthLog` makes the index a global mutable
resource, and 5 agents racing through `git add` / `git commit`
produces these scope-vs-message mismatches.

## Deferred / non-goals

- DELETE endpoint for backups: not in scope (was not in the criteria
  list); v1.4.16 candidate.
- Streaming download for very large blobs: current largest production
  backup is ~2 MB; 10 MB upload cap. Not a v1.4.15 problem.
- Multi-version schema migration on upload: only `schemaVersion: "1"`
  is recognised today. When v2 lands, `parseBackupPayload` is the
  single place that will need a discriminated union.

## Files touched (by commit)

- `d8c549e` (criterion 1, sibling-merged): download endpoint, UI
  download button, integration test, schema module, worker
  `schemaVersion` stamp, EN/DE i18n.
- `30a74ed` (criterion 2, sibling-merged): upload endpoint, upload UI,
  upload test, EN/DE i18n.
- `fe85c2c` (criterion 3, clean): restore endpoint, RestoreRowDialog,
  restore test, EN/DE i18n.
- `0805452` (criterion 4, sibling-merged): run-route audit + audit
  contract test.
- `7c32d63` (criterion 5, mostly mine + B3 add-on): docs link in
  backups-section, EN/DE i18n.
