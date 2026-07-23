-- Durable arrival freshness plus ownership and spend linkage for
-- arrival-reaction provider attempts.
ALTER TABLE "arrival_reactions"
  ADD COLUMN "arrived_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "generation_claim_id" TEXT,
  ADD COLUMN "generation_claimed_at" TIMESTAMP(3),
  ADD COLUMN "generation_reserved_tokens" INTEGER,
  ADD COLUMN "generation_budget_date_key" TEXT,
  ADD COLUMN "generation_provider_invoked_at" TIMESTAMP(3);
