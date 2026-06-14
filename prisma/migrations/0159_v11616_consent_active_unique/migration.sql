-- v1.16.16 — at most one active consent receipt per (user, kind).
--
-- The web-grant heal mint reads `latestActiveReceipt` then `createReceipt`
-- non-atomically. Two concurrent web mounts could each see "no active
-- receipt" and both insert an active `ai_full` row, leaving duplicate
-- active grants the revoke path then has to chase one at a time.
--
-- The application wraps the mint in a transaction with a re-check, but the
-- structural guarantee lives here: a partial unique index over
-- (user_id, kind) restricted to non-revoked rows. Revoked rows carry a
-- non-NULL `revoked_at` and fall outside the predicate, so the append-only
-- grant/revoke history is unaffected — only two *active* rows for the same
-- (user, kind) collide.
CREATE UNIQUE INDEX IF NOT EXISTS "consent_receipts_user_id_kind_active_key"
  ON "consent_receipts" ("user_id", "kind")
  WHERE "revoked_at" IS NULL;
