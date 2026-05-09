# Phase B2 — Withings + moodLog sync robustness

**Status:** done. 4 atomic commits on `origin/main`, all green.

## Commits

- `4db72a8` — `feat(integrations): connection-state + sync-error UI in Settings → Integrations`
- `b290a77` — `fix(integrations): refresh-token failure marks integration as needing re-auth`
- `604dff0` — `feat(integrations): admin Telegram alert on persistent sync failure (>=3 consecutive)`
- `2fbf56d` — `feat(audit): sync failures logged with structured meta`

## What landed

A new `IntegrationStatus` table (migration `0029`) gives every (user,
integration) pair a row with `state` (`connected | error_transient |
error_reauth | disconnected`), `lastSuccessAt`, `lastAttemptAt`,
encrypted `lastError`, `consecutiveFailures` counter, and `alertedAt`
window-guard. The single writer is `src/lib/integrations/status.ts`,
exposing `recordSyncSuccess` / `recordSyncFailure` /
`markReauthRequired` / `markReconnected` / `markDisconnected` /
`getIntegrationStatus` / `isReauthRequired`.

`GET /api/integrations/status` returns both Withings + moodLog
snapshots in one round-trip, including the global threshold so the UI
"{n}/{threshold} consecutive failures" string is server-sourced.

The Settings → Integrations cards both render an
`IntegrationStatusBanner` above the credentials form (state badge,
counter chip, last-success / last-attempt times, destructive-toned
last-error line). The banner self-suppresses when the integration is
fresh-connected with no history.

The Withings + moodLog sync flows (`src/lib/withings/sync.ts`,
`src/lib/moodlog/sync.ts`) now call the helpers on success / failure.
Refresh-token failures classified by Withings status code
(100/101/102/200..299 → `error_reauth`, everything else → transient);
moodLog 401/403 → `error_reauth`. Parked connections short-circuit
inside `getValidToken()` and `syncMoodLogEntries()` so scheduled
pg-boss runs no longer burn quota on a bad credential. The
`/api/withings/callback`, `/api/withings/disconnect`,
`PUT /api/settings/moodlog`, and `DELETE /api/settings/moodlog` routes
all flip the state machine to match (`markReconnected` /
`markDisconnected`).

Persistent failures (≥3 consecutive, configurable via
`INTEGRATION_FAILURE_ALERT_THRESHOLD`) trigger a single admin Telegram
alert per failure burst via the existing dispatcher
(`SYSTEM_ALERT` event type — no new sender, no new channel type, B3
owns dispatcher reliability). A 24h `alertedAt` window prevents flapping
integrations from paging on every retry.

Every failure writes one `AuditLog` row with structured meta
(`integration`, `kind`, `errorCode`, `message`, `attemptNumber`,
`state`). Successes are intentionally not audited — `lastSuccessAt`
on the IntegrationStatus row tracks them at one row per integration
per user instead.

The `lastError` column is AES-256-GCM encrypted at rest because
Withings/moodLog 401 responses can echo URL/apiKey fragments — we
don't want those to land in a future backup tarball.

## Tests

- `src/lib/integrations/__tests__/status.test.ts` — 16 unit tests for
  threshold + alert-window state machine.
- `src/lib/integrations/__tests__/admin-alert.test.ts` — 7 unit tests
  for the Telegram alert payload formatter (extracted as a pure
  function so it's testable without Prisma/dispatcher).
- `src/components/settings/__tests__/integrations-section.test.tsx` —
  4 SSR snapshot tests, one per state, locking the banner contract.
- `tests/integration/integration-status.test.ts` — 8 real-Postgres
  cases: encrypted-at-rest, audit-log shape, alert idempotency,
  reauth parking, reconnect flow, CASCADE delete on User.

Totals: **890 / 890 unit pass** (was 817 baseline; +35 mine + 38 from
B3 racing in alongside). **31 / 31 integration pass** (8 mine).

Typecheck: 0 errors in B2 files. Lint: 0 errors.

## Constraints respected

- No new dependencies added.
- No new dispatcher senders (B3's territory) — only the existing
  `dispatchNotification()` is called.
- No edits to admin-backups files (B1's territory) or workflows (C3).
- Migration `0029_integration_status` committed alongside the schema.
- All sensitive token data stays AES-256-GCM encrypted via
  `src/lib/crypto.ts` (the new `lastError` column included).
- Co-Author trailer on every commit. No `--no-verify`. Pre-commit
  hooks passed.

## Cross-agent observations

- Sibling agents (B3, B-mobile, B1) racing on the same working tree
  caused two side-effects:
  1. My initial `prisma migrate dev` saw schema-vs-DB drift from
     B3's earlier work and emitted irrelevant ALTER statements in the
     migration file. Hand-rewrote the migration to contain only the
     `integration_statuses` DDL; renamed the directory from Prisma's
     timestamp-default to the project's sequential-numeric convention
     (`0029_`) and updated `_prisma_migrations.migration_name` to
     match.
  2. B3's `87a40fd` commit picked up the IntegrationStatus model from
     `schema.prisma` because my stash overlapped B3's index when they
     ran `git add -A`. The schema diff is therefore already on main
     under B3's commit — my commits only carry the migration,
     helper, API, UI, tests, and sync wiring.
- Recommendation for v1.4.16 (echoing A2/A4): each parallel agent
  should run in its own `superpowers:using-git-worktrees` worktree
  to avoid this class of cross-commit bleed.
