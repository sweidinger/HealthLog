-- Session cookies carry a purpose-generated secret rather than the row's cuid
-- primary key.
--
-- A cuid is built for collision-resistant identity, not for unguessability: it
-- embeds a timestamp and a monotonic counter and does not come from a CSPRNG.
-- A session cookie is a bearer credential and must. The cookie now carries a
-- 32-byte random token (`hls_<hex>`) and only its HMAC-SHA256 hash is stored,
-- matching how api_tokens and refresh_tokens already hold their secrets.
--
-- Additive and nullable ON PURPOSE: every session row that exists at deploy
-- time keeps NULL here and stays resolvable by its id, so the release signs
-- nobody out. Those rows cannot have their sliding expiry extended, so the
-- id-as-credential path drains itself within the 30-day session lifetime with
-- no operator action. Postgres permits many NULLs under a unique index, so the
-- constraint below does not conflict with the backfill-free transition.

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN "token_hash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");
