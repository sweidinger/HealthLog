-- Native OIDC SSO session handoff (iOS#49).
--
-- One-time handoff codes bridging the browser-context OIDC callback to the
-- cookie-less native token exchange. The web OIDC flow ends in a session
-- cookie a Bearer-transport native client can never consume; this table lets
-- the callback mint an opaque, PKCE-locked, single-use code that the app
-- exchanges for the standard native token bundle at
-- POST /api/auth/oidc/native/token.
--
-- The raw code (`hlh_<…>`) rides ONLY the custom-scheme redirect; only its
-- HMAC-SHA256 hash is stored, mirroring the refresh-token / MFA-challenge
-- hash-at-rest posture. `issued_refresh_token_hash` records the pair minted at
-- exchange so a replay (a second presentation after consumption) can revoke
-- exactly that family member — refresh-token reuse-detection reach-back.

-- CreateTable
CREATE TABLE "oidc_native_handoffs" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "code_hash" TEXT NOT NULL,
  "code_challenge" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "issued_refresh_token_hash" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ip_address" TEXT,
  "user_agent" TEXT,
  CONSTRAINT "oidc_native_handoffs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — the exchange loads a row by the code's hash; unique so a hash
-- collision can never resolve to two live codes.
CREATE UNIQUE INDEX "oidc_native_handoffs_code_hash_key"
  ON "oidc_native_handoffs" ("code_hash");

-- CreateIndex — per-user audit scans + the FK-cascade delete path.
CREATE INDEX "oidc_native_handoffs_user_id_idx"
  ON "oidc_native_handoffs" ("user_id");

-- CreateIndex — the daily cleanup sweep filters on `expires_at`.
CREATE INDEX "oidc_native_handoffs_expires_at_idx"
  ON "oidc_native_handoffs" ("expires_at");

-- AddForeignKey — deleting a user cascades their handoff rows away.
ALTER TABLE "oidc_native_handoffs"
  ADD CONSTRAINT "oidc_native_handoffs_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
