-- v1.15.13 — source-filter support indexes for the measurements + mood
-- management lists. The new list surfaces add a source filter (and the
-- existing source/value sort). No index leads with `(user_id, source)`
-- today, so a source filter forces a `user_id` scan + in-memory sort —
-- the landmine at 100–200k rows per user. These two additive indexes turn
-- a source filter + recency sort into an index range scan.
--
-- Pure additive `CREATE INDEX IF NOT EXISTS`, no backfill — same low-risk
-- shape as migration 0123.

CREATE INDEX IF NOT EXISTS "measurements_user_id_source_measured_at_idx"
  ON "measurements" ("user_id", "source", "measured_at" DESC);

CREATE INDEX IF NOT EXISTS "mood_entries_user_id_source_mood_logged_at_idx"
  ON "mood_entries" ("user_id", "source", "mood_logged_at" DESC);
