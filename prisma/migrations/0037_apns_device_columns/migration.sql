-- v1.4.23 — APNs send-side scaffolding (Wave 3 / F4)
--
-- Adds the per-device APNs identity pair so the dispatcher can fan a
-- notification out to a user's iPhone via Apple's push gateway. Strictly
-- additive:
--   * Both columns nullable — pre-iOS-app rows on disk stay valid.
--   * `apnsToken` indexed for the dispatcher's per-user lookup +
--     cross-user-hijack guard in `POST /api/devices`.
--   * CHECK constraint enforces "if you store an APNs token, you must
--     also tell us which gateway it belongs to". The iOS client decides
--     `sandbox` vs `production` at registration time — the server never
--     auto-detects (per W1 stream-2 recommendation).
--
-- The `NotificationChannel.type` column is a free-form String, not a
-- Postgres enum, so adding the new "APNS" channel-type value is a
-- TypeScript-side change only — no DDL needed for the channel cascade.

ALTER TABLE "devices"
  ADD COLUMN "apns_token" TEXT,
  ADD COLUMN "apns_environment" TEXT;

ALTER TABLE "devices"
  ADD CONSTRAINT "devices_apns_environment_required_with_token"
  CHECK (
    ("apns_token" IS NULL AND "apns_environment" IS NULL)
    OR
    ("apns_token" IS NOT NULL AND "apns_environment" IS NOT NULL)
  );

CREATE INDEX "devices_apns_token_idx" ON "devices" ("apns_token");
