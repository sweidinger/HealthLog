-- v1.4.15 Phase B2: per-(user, integration) sync status row.
--
-- The Settings → Integrations card needs more than a "connected yes/no"
-- bit to be useful: it must show last-success time, last-attempt time,
-- the most-recent error, and a "needs reconnect" state when the
-- refresh-token grant has revoked. A separate table is preferable to
-- piling more columns onto `users` / `withings_connections` because:
--
--   1. moodLog credentials live on `users`, Withings tokens live on
--      `withings_connections` — neither is a good home for the OTHER
--      integration's status.
--   2. Future integrations (HealthKit, Garmin, etc.) get a row here
--      without a schema migration per integration.
--   3. The (userId, integration) UNIQUE constraint upserts cleanly
--      from the `recordSyncSuccess` / `recordSyncFailure` helpers in
--      `src/lib/integrations/status.ts`.
--
-- Encryption: `last_error` is AES-256-GCM encrypted at the application
-- layer (see `src/lib/crypto.ts`) because some upstream errors echo
-- back fragments of the user's URL or apiKey (moodLog 401 responses
-- can include the supplied Authorization header in the body). Keeping
-- this column ciphertext-only matches the Withings/moodLog credential
-- treatment elsewhere in the schema.
--
-- `consecutive_failures` resets to 0 on the next success and feeds the
-- admin-Telegram alert threshold (default 3, see PERSISTENT_FAILURE_*
-- constants in `src/lib/integrations/status.ts`). `alerted_at` is the
-- idempotency guard so the alert fires once per failure burst, not
-- once per failure.

CREATE TABLE "integration_statuses" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "integration" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'connected',
    "last_success_at" TIMESTAMP(3),
    "last_attempt_at" TIMESTAMP(3),
    "last_error" TEXT,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "alerted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_statuses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "integration_statuses_user_id_idx" ON "integration_statuses"("user_id");
CREATE INDEX "integration_statuses_state_idx" ON "integration_statuses"("state");
CREATE UNIQUE INDEX "integration_statuses_user_id_integration_key" ON "integration_statuses"("user_id", "integration");

ALTER TABLE "integration_statuses" ADD CONSTRAINT "integration_statuses_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
