-- v1.23 — admin-enforced MFA policy + "remember this device" trusted devices.
--
-- 1. `app_settings.mfa_required` — the instance-wide "require a second factor"
--    policy. When true, every account without an active second factor is sent
--    through a forced-enrollment interstitial after sign-in. The effective
--    per-user requirement is `mfa_required OR users.mfa_enforced`.
--
-- 2. `trusted_devices` — the opt-in "remember this device" store. Only the HMAC
--    hash of the cookie token is persisted (keyed by API_TOKEN_HMAC_KEY); the
--    raw token lives only in the user's httpOnly+Secure cookie. A trusted
--    device skips factor 2 within the 30-day window but never satisfies step-up
--    and never replaces the password. Revoked when the second factor is removed.

ALTER TABLE "app_settings" ADD COLUMN "mfa_required" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "trusted_devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trusted_devices_pkey" PRIMARY KEY ("id")
);

-- The token hash is the lookup key on every trusted-device sign-in, and a
-- token is single-purpose per device, so the hash is globally unique.
CREATE UNIQUE INDEX "trusted_devices_token_hash_key" ON "trusted_devices"("token_hash");
CREATE INDEX "trusted_devices_user_id_idx" ON "trusted_devices"("user_id");
-- The expired-trusted-device reaper sweeps on `expires_at`.
CREATE INDEX "trusted_devices_expires_at_idx" ON "trusted_devices"("expires_at");

ALTER TABLE "trusted_devices" ADD CONSTRAINT "trusted_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
