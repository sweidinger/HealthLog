-- v1.3: iOS adapter endpoints + idempotency cache + device registration
--
-- Purely additive:
--   • users.display_name, users.healthkit_config_json, users.healthkit_last_synced_at
--   • new tables: idempotency_keys, devices

-- ── users new columns ─────────────────────────────────────────────────

ALTER TABLE "users"
  ADD COLUMN "display_name" TEXT,
  ADD COLUMN "healthkit_config_json" JSONB,
  ADD COLUMN "healthkit_last_synced_at" TIMESTAMP(3);

-- ── idempotency_keys ──────────────────────────────────────────────────

CREATE TABLE "idempotency_keys" (
  "id"              TEXT PRIMARY KEY,
  "user_id"         TEXT NOT NULL,
  "key"             TEXT NOT NULL,
  "method"          TEXT NOT NULL,
  "path"            TEXT NOT NULL,
  "response_status" INTEGER NOT NULL,
  "response_body"   TEXT NOT NULL,
  "expires_at"      TIMESTAMP(3) NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "idempotency_keys_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "idempotency_keys_user_id_key_method_path_key"
  ON "idempotency_keys" ("user_id", "key", "method", "path");

CREATE INDEX "idempotency_keys_expires_at_idx"
  ON "idempotency_keys" ("expires_at");

-- ── devices ───────────────────────────────────────────────────────────

CREATE TABLE "devices" (
  "id"          TEXT PRIMARY KEY,
  "user_id"     TEXT NOT NULL,
  "platform"    TEXT NOT NULL,
  "token"       TEXT NOT NULL,
  "bundle_id"   TEXT NOT NULL,
  "locale"      TEXT,
  "app_version" TEXT,
  "model"       TEXT,
  "last_seen"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "devices_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "devices_token_key" ON "devices" ("token");
CREATE INDEX "devices_user_id_idx" ON "devices" ("user_id");
