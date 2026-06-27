-- v1.23 — second-factor (MFA) tables.
--
-- Three new stores backing the TOTP / WebAuthn-second-factor / recovery-code
-- flows later waves build on. Phase F lands the empty tables only — no
-- behaviour yet.
--
--   mfa_challenges            single-use step-up ticket minted after a valid
--                             password when the account has a second factor.
--                             The "password OK, awaiting factor 2" state lives
--                             here, never in a half-built session, so no
--                             session/token is issued before factor 2 passes.
--                             Only the ticket HASH is stored (ticket_hash).
--   mfa_recovery_codes        one row per single-use recovery code, Argon2id-
--                             hashed at rest; used_at burns it.
--   webauthn_mfa_credentials  second-factor security keys, kept SEPARATE from
--                             `passkeys` (the passwordless-primary store) —
--                             different semantics, ceremony, management UI.
--                             Mirrors the passkeys field encoding.

CREATE TABLE "mfa_challenges" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ticket_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_challenges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mfa_challenges_ticket_hash_key" ON "mfa_challenges"("ticket_hash");
CREATE INDEX "mfa_challenges_user_id_idx" ON "mfa_challenges"("user_id");
-- The verify path and the expiry sweep both filter on expires_at.
CREATE INDEX "mfa_challenges_expires_at_idx" ON "mfa_challenges"("expires_at");

CREATE TABLE "mfa_recovery_codes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mfa_recovery_codes_user_id_idx" ON "mfa_recovery_codes"("user_id");

CREATE TABLE "webauthn_mfa_credentials" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Security key',
    "credential_id" TEXT NOT NULL,
    "credential_public_key" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "webauthn_mfa_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webauthn_mfa_credentials_credential_id_key" ON "webauthn_mfa_credentials"("credential_id");
CREATE INDEX "webauthn_mfa_credentials_user_id_idx" ON "webauthn_mfa_credentials"("user_id");

ALTER TABLE "mfa_challenges" ADD CONSTRAINT "mfa_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "webauthn_mfa_credentials" ADD CONSTRAINT "webauthn_mfa_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
