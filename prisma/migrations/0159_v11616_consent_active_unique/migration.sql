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

-- Pre-flight dedup. The bug this migration closes already produces duplicate
-- active rows on affected tenants; `CREATE UNIQUE INDEX` scans existing rows
-- and would abort (23505) on any such pair, failing the whole deploy on
-- exactly the tenants the fix targets. Revoke all-but-the-newest active row
-- per (user_id, kind) first so the index can build. The newest active row
-- (latest `created_at`) is the one `latestActiveReceipt` already returns, so
-- the surviving active grant matches current read behaviour; the superseded
-- duplicates get a `revoked_at` marker and stay in the audit history.
UPDATE "consent_receipts" c
  SET "revoked_at" = now()
  WHERE "revoked_at" IS NULL
    AND EXISTS (
      SELECT 1 FROM "consent_receipts" n
      WHERE n."user_id" = c."user_id"
        AND n."kind" = c."kind"
        AND n."revoked_at" IS NULL
        AND n."created_at" > c."created_at"
    );

CREATE UNIQUE INDEX IF NOT EXISTS "consent_receipts_user_id_kind_active_key"
  ON "consent_receipts" ("user_id", "kind")
  WHERE "revoked_at" IS NULL;
