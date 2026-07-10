-- One-shot Google Health sleep duplicate repair (post-v1.28.18 fix).
-- Null = repair pending; stamped once the boot-time full sleep re-read
-- completes for the connection.
ALTER TABLE "google_health_connections" ADD COLUMN "sleep_repaired_at" TIMESTAMP(3);
