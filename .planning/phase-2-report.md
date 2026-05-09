# Phase 2 — v1.4.6 deferred backlog

Status: complete (T2.1, T2.2, T2.3, T2.5). T2.4, T2.6, T2.7 deferred to
phase 4b per orchestration brief — admin refactor moves anchor-id
sections to per-section dynamic routes, so doing those items now would
be thrown away.

## T2.1 — Wipe-all-data scope (commit `512a6a6`)

`src/app/api/admin/data/route.ts` now extends the wipe transaction with
`tx.notificationChannel.deleteMany`, `tx.pushSubscription.deleteMany`,
and `tx.telegramScheduledDeletion.deleteMany`. NotificationPreference
cascades via the schema FK. Encrypted Telegram bot tokens (in
`NotificationChannel.config`) and Web Push endpoints no longer survive a
wipe. Counts are returned to the UI; `messages/{en,de}.json`
`admin.deleteAllConfirmDescription` and `admin.deletedResult` reworded
to spell out the new scope and explicitly note Feedback rows are
preserved (per v1.4.6 T8). `src/components/admin/danger-zone-section.tsx`
threads the three new counts into the i18n result string. Integration
regression test `tests/integration/admin-data-wipe.test.ts` seeds all
three tables, invokes DELETE through `requireAdmin()` with a real admin
session, and asserts the wipe clears them while Feedback + AuditLog
survive.

## T2.2 — Berlin TZ DST math (commit `cb6a59a`)

Added and exported `dayOffsetToBerlinDayKey(now, dayOffset)` from
`src/lib/insights/bucket-series.ts`. The helper anchors at Berlin Y-M-D
via Intl (DST-immune), then subtracts in UTC-anchored Berlin-day space
where every day is 86_400_000 ms. The three `pairDailyBuckets` helpers
in `blood-pressure-status.ts`, `weight-status.ts`, and `mood-status.ts`
plus the four other call sites that previously synthesised a date via
`now − dayOffset · MS_PER_DAY` now use the helper. Pairs carry `dayKey`
directly so callers don't re-format. The synthesised `date` field is
anchored at UTC midnight of the Berlin day so any code still formatting
it via `toBerlinDayKey()` gets the same DST-safe answer. Pulse-status
had no `pairDailyBuckets` and no offending math — left untouched.
Tests in `src/lib/insights/__tests__/bucket-series.test.ts` cover both
2024 DST boundaries from late-evening and early-morning Berlin times.

## T2.3 — /api/insights/generate provider error (commit `5403821`)

`src/app/api/insights/generate/route.ts` wraps
`provider.generateCompletion(...)` in try/catch and mirrors the v1.4.5
ai/test categorisation: 401/403 → 422 ("AI provider rejected the
request — check your API key in Settings > AI"), 5xx → 503 ("AI
provider temporarily unavailable, try again in a moment"), 429 → 429,
unknown → 422 generic. Full error details land in the Wide Event via
`annotate()` so the operator can debug without leaking provider URLs /
partial keys to the client. New unit test
`src/app/api/insights/generate/__tests__/route.test.ts` covers
401/403/429/500/503/unknown mapping.

## T2.5 — redactSecrets regex word-boundary (commit `d6696cf`)

`src/lib/logging/redact.ts` regex tightened from
`/sk-(?:ant-)?[A-Za-z0-9_-]+/g` to
`/(^|[^A-Za-z0-9])sk-(?:ant-)?[A-Za-z0-9_-]{8,}/g`. Capture group 1 is
the leading separator, preserved in the substitution. Tests in
`src/lib/logging/__tests__/redact.test.ts` cover the v1.4.6-QA
false-positives (`task-force`, `risk-management`, `disk-io`, plus
mid-word negatives) AND keep the positive coverage for
`sk-1234567890abcdef`, `sk-ant-1234567890abcdef`, and the various
preceding-separator cases.

## CI / verification

- `pnpm typecheck` — clean
- `pnpm lint` — 0 errors / 12 warnings (pre-existing, not in scope)
- `pnpm format:check` — clean (sweep landed in `6b88e56`)
- `pnpm test` — 733 passed (95 files)
- `pnpm test:integration tests/integration/admin-data-wipe.test.ts` —
  passed (the existing 10 tests in the suite were not re-run in the
  sweep but have not been touched)

Pushed to `origin/main` through commit `6b88e56`.
