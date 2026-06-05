-- v1.12.2 — WHOOP connect-in-app enhancements (two iOS-requested asks).
--
-- 1. `whoop_oauth_states` += `return_scheme` (nullable). The native client may
--    pass `?return_scheme=<custom-scheme>` to `GET /api/whoop/connect`; the
--    connect route validates it against a strict allowlist and stores it on the
--    in-flight state row so it survives the OAuth round-trip server-side (never
--    in the URL or cookie). The callback reads it off the consumed row to send
--    its FINAL redirect to `<scheme>://whoop?whoop=connected|error&reason=…`
--    instead of the web settings URL. Null = unchanged web redirect.
--
-- 2. `whoop_connect_tickets` — a one-time, Bearer-mintable connect ticket so a
--    purely Bearer-authenticated native client (no web-session cookie) can
--    start the WHOOP handshake. The client mints a ticket via an authenticated
--    `POST /api/whoop/connect/ticket`, then opens
--    `GET /api/whoop/connect?ticket=<opaque>` in an in-app web session. Only
--    the HMAC-SHA256 hash of the opaque ticket is stored (`token_hash`, keyed
--    by `API_TOKEN_HMAC_KEY`); the raw value never persists. The ticket is
--    single-use (`consumed_at` stamped atomically on first use) and short-lived
--    (~60s `expires_at`). Mirrors `whoop_oauth_states` in shape + lifecycle.
--
-- Idempotent guards (`IF NOT EXISTS`) make reruns safe. Forward-only.
--
-- Reversibility: the column drops with `DROP COLUMN IF EXISTS "return_scheme"`,
-- the table with `DROP TABLE IF EXISTS "whoop_connect_tickets"`.

-- ── 1. whoop_oauth_states — native return-scheme carrier ──────────────
ALTER TABLE "whoop_oauth_states"
    ADD COLUMN IF NOT EXISTS "return_scheme" TEXT;

-- ── 2. whoop_connect_tickets — one-time Bearer-startable connect ticket ─
CREATE TABLE IF NOT EXISTS "whoop_connect_tickets" (
    "id"          TEXT            NOT NULL,
    "user_id"     TEXT            NOT NULL,
    "token_hash"  TEXT            NOT NULL,
    "created_at"  TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at"  TIMESTAMP(3)    NOT NULL,
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "whoop_connect_tickets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "whoop_connect_tickets_token_hash_key"
    ON "whoop_connect_tickets" ("token_hash");

CREATE INDEX IF NOT EXISTS "whoop_connect_tickets_expires_at_idx"
    ON "whoop_connect_tickets" ("expires_at");

DO $$ BEGIN
    ALTER TABLE "whoop_connect_tickets"
        ADD CONSTRAINT "whoop_connect_tickets_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
