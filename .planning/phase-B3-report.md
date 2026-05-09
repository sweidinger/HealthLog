# Phase B3 — Notification reliability

Status: complete · 2026-05-09T21:05+02:00

## What shipped

Three layered fixes on top of a dispatcher that previously fired
channels best-effort and kept retrying on a 410 Gone every 60s:

### 1. Auto-disable on persistent hard rejects

- Migration 0028 adds 6 columns to `notification_channels`
  (`disabled_reason`, `consecutive_failures`, `last_success_at`,
  `last_failure_at`, `last_failure_reason`, `next_retry_at` — all
  nullable / zero-default, no-op for existing rows).
- `src/lib/notifications/retry-policy.ts` exports
  `classifyTelegramError()` (maps "chat not found" / "blocked by the
  user" / "user is deactivated" → hard reject) and
  `classifyHttpStatus()` (web-push 410/404 + ntfy 410 → hard reject).
- `src/lib/notifications/channel-state.ts` is the only writer of the
  new columns. `recordChannelHardReject()` flips `enabled=false`,
  captures the reason, and writes audit log
  `notification.channel.auto_disabled` with `kind=hard_reject`.

### 2. Exponential backoff with give-up after 5 transient failures

- Same retry-policy module exports `BACKOFF_SCHEDULE_MS = [30s, 5min,
  30min, 2h]` (frozen) and `nextRetryAt(consecutiveFailures, now)`.
- `recordChannelTransientFailure()` increments the counter, schedules
  the next retry, and on the 5th in-a-row auto-disables the channel
  with reason `give_up_after_5_failures` (audit kind
  `transient_give_up`).
- Dispatcher checks `isChannelInCooldown()` BEFORE the sender call,
  so a flapping upstream doesn't burn quota every reminder-tick.

### 3. Status UI in Settings → Notifications

- `GET /api/notifications/status` returns each channel's derived
  state (`active` / `auto_disabled` / `sending_paused` /
  `manually_disabled`), last success/failure timestamps,
  consecutive-failure counter, and `next_retry_at` when in
  cooldown.
- `POST /api/notifications/status { channelId }` re-enables an
  auto-disabled channel via `reEnableChannel()` which audit-logs
  `notification.channel.re_enabled`.
- `<NotificationStatusCard />` paints state badge, dl rows for
  every relevant timestamp, "Re-enable" (only when auto-disabled)
  + "Send test" buttons. TanStack Query polls every 30s.
- Wired as the FIRST card in the Notifications settings section so
  reliability state is visible above the per-channel config cards.

## Tests

- `src/lib/notifications/__tests__/retry-policy.test.ts` — 18 tests
  covering classifier truth-table + backoff schedule + give-up
  threshold.
- `src/lib/notifications/__tests__/channel-state.test.ts` — cooldown
  helper boundary cases.
- `src/lib/notifications/__tests__/dispatcher.test.ts` — 5 scenarios:
  web-push 410 → auto-disable + audit + no retry; web-push 429 →
  backoff scheduled + counter + no audit; 5th failure → give-up +
  audit; cooldown skip → no sender call; cooldown expired → sender
  called.
- `src/components/settings/__tests__/notification-status-card.test.tsx`
  — 6 SSR smoke tests, every state branch + EN/DE locale.

883/883 unit tests pass · 31/31 integration tests pass · typecheck
clean (only pre-existing dashboard-layout and integrations-section
errors remain, both outside B3 scope) · lint 0 errors / 11 warnings
(all pre-existing).

## Commits on origin/main

- `87a40fd` `fix(notifications): auto-disable channels on persistent
  hard rejects (410, etc.)` — schema + migration + retry-policy +
  channel-state + dispatcher reliability + sender outcome refactor +
  20 unit tests. Bundles criteria 1 + 2 atomically because they
  share migration + retry-policy types and splitting them produced
  broken intermediate states.
- `a3c0130` `feat(settings): notification channel status UI with
  re-enable + test` — wires `<NotificationStatusCard />` into the
  notifications settings section.

## Cross-agent collisions encountered

Marathon's "5 parallel agents on shared cwd" pattern produced two
race-conditions during this phase:

1. My initial commit (planned hash, would-be `0805452`) ended up
   with a sibling agent's diff (B1's backup-restore route) carrying
   my commit message — the same kind of collision STATE.md flagged
   during phase A. I `git reset HEAD~1` + recommitted via
   `git commit -o <files>` to bind exact paths.
2. Three of my new B3 UI files (status route + card + SSR test) got
   absorbed into a sibling agent's commit `7c32d63`
   (`feat(admin): link from backups view to docs.healthlog.dev/...`)
   during their `git add`. The files are correct on main, just under
   a misleading subject. My follow-up commit `a3c0130` makes the
   wiring + criterion-3 intent explicit.

Recommendation for v1.4.16: spawn each agent in its own git worktree
(`superpowers:using-git-worktrees`) to eliminate the shared-cwd
staging race entirely. STATE.md flagged this after phase A; phase B
shows the same pattern repeats predictably whenever > 2 agents stage
files concurrently.

## Did NOT touch (scope guards)

- `src/components/admin/backups-section.tsx` and backup endpoints
  (B1's territory).
- `src/lib/withings/`, `src/lib/moodlog/`, integrations-section.tsx
  (B2's territory).
- `.github/workflows/*` (C3's territory).

## Notes for follow-up work

- `consecutive_failures` is incremented on hard-reject too (so the
  status UI can show "5 in a row before we gave up"). Re-enable
  resets to 0.
- The reminder-worker still calls `dispatchNotification()` once per
  scheduled phase; the cooldown-skip protects against quota burn,
  but a future v1.4.16 follow-up could surface "X reminders skipped
  while channel paused" as a Wide Event metric.
- Telegram webhook flow (`src/app/api/telegram/webhook/route.ts`)
  still uses `sendTelegramMessage` directly with the legacy
  `SendMessageResult` shape — not in scope for B3 (it's the inbound
  bot reply path, not a dispatch). The `errorDescription` field
  added in this phase is available there if a future refactor wants
  to consume it.
