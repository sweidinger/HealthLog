-- The per-workout Activity Insight paragraph.
--
-- Its own table rather than a column on `workouts` because a workout delete is
-- a HARD delete: the FK below cascades, so the paragraph can never outlive the
-- session it describes. Keeping it out of `workouts` also keeps the generation
-- provenance off the row every list read selects from.
--
-- Rows are written ONLY by the `workout-insight-generate` worker, dispatched by
-- the data-arrival spine when a workout genuinely lands. No read path creates
-- one, so every workout that predates this migration stays without a row — and
-- renders no card — forever, at zero provider cost.
--
-- `paragraph_encrypted` is AES-256-GCM at rest, following the
-- `insight_narratives.encrypted_content` precedent, and is registered in
-- `src/lib/crypto/encrypted-columns.ts` so key rotation covers it.
--
-- `input_hash` fingerprints the deterministic evidence the paragraph was built
-- from together with the prompt version: a device re-post of the same session
-- hashes identically and is refused before any provider is resolved.

CREATE TABLE "workout_insights" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "workout_id" TEXT NOT NULL,
  "paragraph_encrypted" BYTEA NOT NULL,
  "input_hash" TEXT NOT NULL,
  "prompt_version" TEXT NOT NULL,
  "provider_type" TEXT,
  "locale" TEXT NOT NULL,
  "generated_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "workout_insights_pkey" PRIMARY KEY ("id")
);

-- One paragraph per workout. This is also the second half of the
-- double-post defence: the singleton queue key collapses a burst, and this
-- constraint makes the claim durable even if two workers do run.
CREATE UNIQUE INDEX "workout_insights_workout_id_key"
  ON "workout_insights"("workout_id");

-- The daily-cap count: rows for one user inside a generated_at window.
CREATE INDEX "workout_insights_user_id_generated_at_idx"
  ON "workout_insights"("user_id", "generated_at");

ALTER TABLE "workout_insights"
  ADD CONSTRAINT "workout_insights_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workout_insights"
  ADD CONSTRAINT "workout_insights_workout_id_fkey"
  FOREIGN KEY ("workout_id") REFERENCES "workouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
