-- v1.15.20 — registration invite tokens.
--
-- Admits a signup while open registration is disabled. Only the
-- HMAC-SHA256 hash of the raw token is stored (the ApiToken scheme);
-- `expires_at` is mandatory (route-capped at 30 days), `uses`/`max_uses`
-- carry the consumption budget, `used_by` tracks the most recent consumer
-- and survives account deletion as NULL. Additive + non-destructive.
CREATE TABLE "invite_tokens" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "used_by" TEXT,
    "max_uses" INTEGER NOT NULL DEFAULT 1,
    "uses" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "invite_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invite_tokens_token_hash_key" ON "invite_tokens"("token_hash");

CREATE INDEX "invite_tokens_expires_at_idx" ON "invite_tokens"("expires_at");

ALTER TABLE "invite_tokens"
  ADD CONSTRAINT "invite_tokens_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "invite_tokens"
  ADD CONSTRAINT "invite_tokens_used_by_fkey"
  FOREIGN KEY ("used_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
