# Phase B7 — Settings → Export menu (Arztbrief consolidated)

Status: complete on origin/main.

## What shipped

- `<ExportSection>` (`src/components/settings/export-section.tsx`) — five
  cards (Doctor Report PDF, Measurements CSV, Medications CSV with optional
  intake-history toggle, Mood CSV, Full JSON Backup), mobile-first stacking
  on `<md` and a 2-column grid on `>=md`. Each card carries a stable
  `data-testid` so the e2e suite can target it without depending on the
  localised label.
- New dynamic-route slug `/settings/export` wired through `SETTINGS_SECTION_SLUGS`
  - `SECTION_COMPONENTS` + `SETTINGS_SECTIONS` (sidebar nav + mobile strip).
    `<SectionPlaceholder>` learned the new icon so a future slug addition
    cannot crash type-checking.
- `<AdvancedSection>` simplified to the danger-zone card alone — every
  export path moved out into `<ExportSection>`. The "wipe all data"
  surface should never live next to a one-click export button.
- Doctor-report e2e spec (`e2e/doctor-report.spec.ts`) follows the
  entry-point relocation from `/settings/advanced` to `/settings/export`
  and now drives the dialog through the submit step.
- Four new endpoints under plain segments (vitest can't resolve dotted
  segments cleanly, so the file extension lives in `Content-Disposition`
  filename instead):
  - `GET /api/export/measurements` → text/csv, optional `since`/`until`
  - `GET /api/export/medications` → text/csv, optional intake-history block
  - `GET /api/export/mood` → text/csv, optional `since`/`until`
  - `GET /api/export/full-backup` → application/json matching the
    canonical `backupPayloadSchema` so the user can hand the file to
    an admin and `POST /api/admin/backups/upload` accepts it as-is.
- Each endpoint goes through `apiHandler` + `requireAuth` (cookie session
  OR Bearer token), shares a single `export:<userId>` 10/h rate-limit
  bucket, and writes a `user.export.<kind>` audit-log entry with the
  resolved filter.
- 10 unit tests (`src/app/api/export/__tests__/per-type-routes.test.ts`)
  pin the auth gate, content-type, content-disposition, and audit-log
  shape. 9 integration tests
  (`tests/integration/export-per-type.test.ts`) round-trip real Postgres
  rows against the testcontainer and assert no cross-tenant leak. New
  e2e smoke (`e2e/settings-export.spec.ts`) asserts the five-card
  rendering + drives a real Measurements CSV download.

## i18n

- New keys under `settings.sections.export.*` in EN + DE. Old
  `settings.sections.advanced.description` tightened to "Import, danger
  zone." (was "Export, import, danger zone.") — export's no longer here.

## Cross-agent staging notes

- A verification-gate stash/restore loop ran while I was iterating on
  the integration-test suite. It absorbed my four route files + their
  unit tests + the integration test into another agent's
  "docs(planning): mark phase B3 (host-load chart) complete" commit
  (226cac4) — code shipped under the right author with my
  `Co-Authored-By` trailer, but the commit summary doesn't name the
  export work. Two follow-up commits (d5c8912, 830b2b0) realigned the
  `<ExportSection>` endpoint URLs and the integration-test import
  paths from the old dotted-segment form.

## Verification

- `pnpm test src/app/api/export src/components/settings src/lib/__tests__/i18n-locale-integrity.test.ts` — all pass
  for the B7 scope. Two pre-existing failures elsewhere in the repo
  belong to B5a (insights citation footnote i18n drift), out of scope.
- `pnpm test:integration export-per-type` — 9/9 pass.
- `pnpm typecheck` clean for the B7 scope; pre-existing errors in B3/B4
  territory (audit-log/actions, host-metric-sampler bigint literals,
  insight-advisor citation type) are out of bucket.

## Commits on origin/main

- `621109c feat(settings): export-section consolidates doctor-report, CSVs, JSON backup`
- `a512650 feat(settings): /settings/export dynamic route wired into sidebar`
- `94c748d refactor(doctor-report): entry-point relocated under /settings/export`
- `226cac4 docs(planning): mark phase B3 (host-load chart) complete`
  (absorbed B7's endpoint files + tests during a parallel-agent
  staging race — see cross-agent note above)
- `d5c8912 fix(export-section): point download buttons at the new plain-segment endpoints`
- `830b2b0 test(export): integration test points at the new plain-segment endpoints`
- `e628f33 test(export): coverage for export-section + endpoints`
