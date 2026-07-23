-- Durable single-spend ownership and local-day capacity reservations for
-- per-workout Activity Insight generation. Existing insight rows remain valid
-- and are counted by the worker until a claim row exists for their workout.
CREATE TABLE "workout_insight_generation_claims" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "workout_id" TEXT NOT NULL,
  "local_date" TEXT NOT NULL,
  "claim_id" TEXT,
  "claimed_at" TIMESTAMP(3),
  "provider_invoked_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "workout_insight_generation_claims_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workout_insight_generation_claims_workout_id_key"
  ON "workout_insight_generation_claims"("workout_id");

CREATE UNIQUE INDEX "workout_insight_generation_claims_claim_id_key"
  ON "workout_insight_generation_claims"("claim_id");

CREATE INDEX "workout_insight_generation_claims_user_id_local_date_idx"
  ON "workout_insight_generation_claims"("user_id", "local_date");

ALTER TABLE "workout_insight_generation_claims"
  ADD CONSTRAINT "workout_insight_generation_claims_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workout_insight_generation_claims"
  ADD CONSTRAINT "workout_insight_generation_claims_workout_id_fkey"
  FOREIGN KEY ("workout_id") REFERENCES "workouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
