# Phase B6 — Doctor-report v2

Status: done · 2026-05-09T21:38+02:00 · two commits on origin/main

## Shipped

1. `d692119` `feat(doctor-report): configurable date range with default
   last-90-days` — new `<DoctorReportDialog>` (Radix Dialog + native
   `<input type="date">`) prompts before the request fires; defaults end=today,
   start=today-90d; presets 90d / 6mo / 12mo. New
   `normaliseDateRange()` parses `{ startDate?, endDate?, days? }` with
   silent fallback to last-90-days. `collectDoctorReportData()` accepts a
   range and filters Prisma `findMany` with both `gte` AND `lte` on
   measurements, intake events, and mood entries. PDF cover renders the
   explicit period from `period.start`/`period.end` (legacy `period.since`
   preserved for backwards compat). Audit-log + Wide-Event annotations
   record `startDate` / `endDate` for forensic replay.

2. `28467b2` `feat(doctor-report): practice name on cover page (persisted
   as user preference)` — new optional "Praxis / clinic name" field on
   the dialog, pre-filled from the user's last value. Persisted in
   `User.lastReportPracticeName` (migration `0031_user_last_report_practice_name`).
   `sanitisePracticeName()` strips ASCII C0 + DEL controls, collapses
   whitespace, hard-caps at 120 chars before any layout-sensitive
   rendering. PDF cover prints the line in 11pt bold above the separator
   when set; omitted when `null`. Both client + server PDF renderers
   carry the change. `/api/auth/me` echoes the value so the dialog
   pre-fills without an extra round-trip. Audit + Wide-Event annotations
   record `practiceNameProvided: boolean` (NOT the value).

## Validation

- `pnpm test` — 965 / 965 unit pass (was 957 at phase start; +8 net
  after the commit-1 / commit-2 split + reorg).
- `pnpm test:integration` — 31 / 31 pass.
- `pnpm typecheck` — 0 new errors; the 3 pre-existing dashboard-layout
  test errors flagged in STATE.md continue to belong to A4.
- `pnpm lint` — 0 errors, 11 warnings (none in B6 files; the 2
  errors in `tour-launcher.tsx` are B5 territory and untouched).

## Race-condition notes

Sibling agents kept rewriting `prisma/schema.prisma`,
`src/components/settings/advanced-section.tsx`, and the test fixtures
mid-session. Recovered each time by reading the current file before the
next Edit and re-applying the diff. The `useEffect` reset pattern in
the dialog flagged the strict `react-hooks/set-state-in-effect` rule;
switched to the codebase-canonical "track-the-trigger" pattern from
`account-section.tsx` (store last-observed `open`, react during render).

## Files

- New: `src/components/doctor-report/doctor-report-dialog.tsx` +
  test, `src/lib/__tests__/doctor-report-data.test.ts`,
  `prisma/migrations/0031_user_last_report_practice_name/migration.sql`.
- Touched: `src/lib/doctor-report-data.ts`,
  `src/lib/doctor-report-pdf-core.ts`, `src/lib/doctor-report-pdf.ts`,
  `src/app/api/doctor-report/route.ts`,
  `src/app/api/doctor-report/pdf/route.ts`,
  `src/app/api/auth/me/route.ts`,
  `src/components/settings/advanced-section.tsx`,
  `prisma/schema.prisma`, `messages/{en,de}.json`,
  `src/lib/__tests__/doctor-report-pdf-core.test.ts`,
  `src/app/api/doctor-report/__tests__/pdf-route.test.ts`.

## Out of scope / deferred

- E2E test for the dialog open → submit flow — the existing
  `e2e/doctor-report.spec.ts` mocks the data endpoint and clicks the
  trigger; updating it to drive the new dialog is out of B6 scope and
  better landed alongside C3's e2e reliability work.
- DB-level encryption of `lastReportPracticeName` — the field is
  user-provided, low-sensitivity, and already protected by HealthLog's
  cookie-session auth. C-3 / phase-D security review can re-evaluate.
