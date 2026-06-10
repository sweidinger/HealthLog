-- v1.16.0 — invite redemption ledger + soft revocation.
--
-- `invite_tokens.used_by` keeps only the LAST consumer (multi-use
-- invites overwrite it); `invite_redemptions` carries one row per
-- admitted signup so the admin table can show the full history with
-- timestamps. `user_id` survives account deletion as NULL — the row
-- still documents that a use was consumed.
--
-- `revoked_at` turns revocation into a soft state: a revoked invite
-- keeps its history visible instead of vanishing, and the consume path
-- refuses it like an expired one. Additive + non-destructive.
ALTER TABLE "invite_tokens" ADD COLUMN "revoked_at" TIMESTAMP(3);

CREATE TABLE "invite_redemptions" (
    "id" TEXT NOT NULL,
    "invite_id" TEXT NOT NULL,
    "user_id" TEXT,
    "redeemed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invite_redemptions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "invite_redemptions_invite_id_idx" ON "invite_redemptions"("invite_id");

ALTER TABLE "invite_redemptions"
  ADD CONSTRAINT "invite_redemptions_invite_id_fkey"
  FOREIGN KEY ("invite_id") REFERENCES "invite_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "invite_redemptions"
  ADD CONSTRAINT "invite_redemptions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: every invite that already recorded a consumer becomes one
-- redemption row, stamped with the invite's `used_at`. Invites whose
-- consumer account was deleted (`used_by` NULL but `uses` > 0) cannot
-- be reconstructed and stay ledger-less — the use counter still counts.
INSERT INTO "invite_redemptions" ("id", "invite_id", "user_id", "redeemed_at")
SELECT
  'invred_' || md5(random()::text || clock_timestamp()::text),
  "id",
  "used_by",
  COALESCE("used_at", "created_at")
FROM "invite_tokens"
WHERE "used_by" IS NOT NULL;
