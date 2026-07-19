-- The data-arrival spine's durable reaction marker.
--
-- One row per (user, arrival kind, local day), written by the `data-arrival`
-- worker after a SALIENT ingest. A backfill never reaches here: the seam
-- classifier drops historical and future-dated samples before anything is
-- enqueued, so a ten-year import writes nothing to this table.
--
-- The unique index is the point of the table, not decoration. It carries three
-- separate contracts at once:
--   1. the "just in" marker every reaction surface reads,
--   2. the at-most-one-generated-line per kind per day claim — the worker
--      inserts with ON CONFLICT DO NOTHING, so a lost race simply means
--      another worker already owns today's line,
--   3. the audit trail of what the spine actually reacted to.
--
-- `line_encrypted` is AES-256-GCM at rest, following the
-- `insight_narratives.encrypted_content` precedent. It is NULLABLE on purpose:
-- the marker is the feature and the sentence is garnish, so a provider-less
-- install fills the table normally and simply never sets this column.
--
-- Rows are pruned after 14 days by the daily `arrival-reaction-cleanup` job.

CREATE TABLE "arrival_reactions" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "local_date" TEXT NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "ref_id" TEXT,
  "line_encrypted" BYTEA,
  "generated_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "arrival_reactions_pkey" PRIMARY KEY ("id")
);

-- The once-per-kind-per-local-day claim. Do NOT widen this to include
-- `ref_id`: the day scope IS the throttle.
CREATE UNIQUE INDEX "arrival_reactions_user_id_kind_local_date_key"
  ON "arrival_reactions" ("user_id", "kind", "local_date");

-- The reaction surfaces read "today's rows for this user".
CREATE INDEX "arrival_reactions_user_id_local_date_idx"
  ON "arrival_reactions" ("user_id", "local_date");

-- The nightly retention sweep deletes by age.
CREATE INDEX "arrival_reactions_created_at_idx"
  ON "arrival_reactions" ("created_at");

ALTER TABLE "arrival_reactions"
  ADD CONSTRAINT "arrival_reactions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
