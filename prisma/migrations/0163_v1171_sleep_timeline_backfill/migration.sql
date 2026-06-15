-- v1.17.1 — one-shot sleep-timeline backfill markers.
--
-- WHOOP's v2 API returns only per-stage sleep DURATION totals (no onset
-- timestamps), and the pre-fix mapper stamped all five stage totals on the one
-- sleep-END instant. The hypnogram then reconstructed every stage as a span
-- touching the night's right edge — the stacked-bar artefact with no clock
-- times. The fix reconstructs an ordered, contiguous per-segment timeline.
--
-- Withings stamped each sleep segment with its START while every reader treats
-- `measured_at` as the segment END, shifting each night one segment-length
-- earlier. The fix stamps the END.
--
-- Both fixes change the stored row shape / instant, so existing rows must be
-- re-synced. The boot-time backfill (per connection) deletes the affected
-- SLEEP_DURATION rows, re-syncs with the corrected mapper, re-folds the rollup
-- tier, and stamps `sleep_timeline_backfill_at` so the discovery query drops
-- the connection. Null = backfill not yet run; the marker makes the one-shot
-- idempotent across reboots.
ALTER TABLE "whoop_connections" ADD COLUMN "sleep_timeline_backfill_at" TIMESTAMP(3);
ALTER TABLE "withings_connections" ADD COLUMN "sleep_timeline_backfill_at" TIMESTAMP(3);
