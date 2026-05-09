-- v1.4.15 Phase B3: notification reliability metadata.
--
-- Until this release the dispatcher fired channels best-effort and the
-- only feedback signal we kept was a Wide-Event warning per failure.
-- That meant a stale Web-Push subscription kept burning bandwidth on
-- every dispatch (a 410 from FCM is a permanent reject — re-trying it
-- never recovers), a Telegram bot whose chat was deleted got the same
-- treatment, and the user never saw the channel's actual health.
--
-- These columns let the dispatcher:
--  1. Auto-disable a channel on a hard reject (HTTP 410, Telegram
--     "chat not found" or "blocked by the user", ntfy 410), with the
--     reason captured for the Settings UI.
--  2. Apply exponential backoff [30s, 5min, 30min, 2h] to soft errors
--     (5xx, 429, network timeout) instead of hammering a flapping
--     upstream — and after 5 consecutive transient failures, treat
--     the channel as effectively dead and auto-disable it too.
--  3. Surface "Active / Auto-disabled / Sending paused" + last
--     success / failure timestamps in Settings → Notifications, with
--     a "Re-enable" button that clears `disabled_reason` +
--     `consecutive_failures` and a "Send test" button.
--
-- All columns are nullable / zero-default so the migration is a no-op
-- for existing rows: a healthy channel reports
--   consecutive_failures=0, last_success_at=null, disabled_reason=null,
-- which renders as "Active (no recent send recorded)" in the UI.

ALTER TABLE "notification_channels"
  ADD COLUMN "disabled_reason"      TEXT,
  ADD COLUMN "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_success_at"      TIMESTAMP(3),
  ADD COLUMN "last_failure_at"      TIMESTAMP(3),
  ADD COLUMN "last_failure_reason"  TEXT,
  ADD COLUMN "next_retry_at"        TIMESTAMP(3);
