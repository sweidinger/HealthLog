-- v1.11.0 — clinician share links.
--
-- A user mints a link (`hls_<48 hex>`) they hand a clinician, who opens it in
-- any browser with no account and sees a scoped, time-limited, revocable
-- read-only view of the health record. The raw token is stored ONLY as an
-- HMAC-SHA256 hash (`token_hash`, same scheme as `api_tokens.token_hash`);
-- the plaintext is returned to the owner exactly once at creation.
--
-- The scope is FROZEN at creation: `range_start`, `sections_json` and
-- `resource_types` are write-once — a share can NEVER widen later. Only
-- `revoked_at`, `last_access_at` and `access_count` mutate after mint, which
-- mirrors the append-only spirit of `consent_receipts`. `expires_at` is
-- mandatory (capped at SHARE_LINK_MAX_DAYS, default 90) — no never-expiring
-- share. Deleting the user cascades every share away (clean GDPR-erasure).
--
-- Purely additive: one new table, no enum changes, no backfill. Forward-only;
-- dropping the table loses only the share links (read access is revoked).

CREATE TABLE IF NOT EXISTS "clinician_share_links" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "range_start" TIMESTAMP(3) NOT NULL,
    "range_end" TIMESTAMP(3),
    "sections_json" JSONB NOT NULL,
    "resource_types" TEXT[],
    "allow_fhir_api" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "last_access_at" TIMESTAMP(3),
    "access_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "clinician_share_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "clinician_share_links_token_hash_key"
    ON "clinician_share_links" ("token_hash");

CREATE INDEX IF NOT EXISTS "clinician_share_links_user_id_created_at_idx"
    ON "clinician_share_links" ("user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "clinician_share_links_expires_at_idx"
    ON "clinician_share_links" ("expires_at");

ALTER TABLE "clinician_share_links"
    ADD CONSTRAINT "clinician_share_links_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
