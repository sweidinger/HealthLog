-- v1.19.2 — Telegram: one chat ⇄ one account, plus a TELEGRAM measurement
-- source for numeric-reply capture.
--
-- 1. `measurement_source` += `TELEGRAM`. A numeric reply to a measurement
--    reminder is captured as a Measurement that enters through the
--    chat-bound webhook (not the cookie/Bearer client write path), so it
--    carries its own source label. Purely-additive enum extension; no row
--    touched. `ADD VALUE IF NOT EXISTS` makes the rerun safe. The new value
--    is NOT used elsewhere in this migration, so it is safe to extend the
--    enum in the same step (Postgres only forbids USING a freshly-added
--    value in the same transaction). Mirrors the 0160 source-extension
--    precedent.
--
-- 2. `users.telegram_chat_id` UNIQUE. The inbound webhook resolves the user
--    from `telegram_chat_id` (`findTelegramUser`); a chat id shared across
--    two accounts would route a reply / button tap / numeric capture
--    ambiguously. The index is over a nullable column, so Postgres' default
--    NULL-distinct semantics keep an unlinked account (NULL chat id) from
--    ever colliding — only two accounts both binding the SAME non-NULL chat
--    id are rejected, which is the bug we are closing.
--
--    Defensive pre-clean: should any duplicate non-NULL chat ids already
--    exist (a chat re-pointed between accounts before this constraint
--    landed), keep the most recently updated row's binding and NULL out the
--    stale ones so the unique index can be built without error. The cleared
--    accounts simply fall back to "Telegram not linked" and re-link from
--    Settings; no data beyond the binding is touched.
--
-- Idempotent guards (`IF NOT EXISTS`) make a rerun safe. Forward-only.
--
-- Reversibility: Postgres cannot remove an enum value, so `TELEGRAM` stays
-- (inert with no rows). The unique index drops with
-- `DROP INDEX IF EXISTS "users_telegram_chat_id_key"`.

-- ── 1. measurement_source — append the user-driven webhook source ──────
ALTER TYPE "measurement_source" ADD VALUE IF NOT EXISTS 'TELEGRAM';

-- ── 2. users.telegram_chat_id — one chat binds one account ─────────────
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY telegram_chat_id
      ORDER BY updated_at DESC, id DESC
    ) AS rn
  FROM "users"
  WHERE telegram_chat_id IS NOT NULL
)
UPDATE "users" u
SET telegram_chat_id = NULL
FROM ranked
WHERE u.id = ranked.id AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "users_telegram_chat_id_key"
  ON "users" ("telegram_chat_id");
