-- v1.4.16 phase B5b: ordered fallback chain for multi-provider AI redundancy.
--
-- Up to v1.4.15 each user resolved exactly one AI provider per insight
-- request and a hard failure (401, 5xx, network timeout) bricked the
-- generation entirely. This column stores an ordered list of provider
-- preferences so the runner can fall through on hard failure to a
-- secondary configured provider.
--
-- Shape (JSONB so admin tools can grep/index later):
--   [
--     { "providerType": "codex",     "priority": 1, "enabled": true },
--     { "providerType": "openai",    "priority": 2, "enabled": true },
--     { "providerType": "anthropic", "priority": 3, "enabled": false }
--   ]
--
-- Credentials are NOT inlined here — they continue to live in the
-- dedicated encrypted columns (codex_*, ai_openai_key_encrypted,
-- ai_anthropic_key_encrypted, ai_local_key_encrypted) so AES-256-GCM
-- key-rotation via scripts/rotate-encryption-key.ts keeps working
-- unchanged. The chain is pure metadata: which providers, in what order.
--
-- NULL preserves the legacy single-provider behaviour driven by
-- users.ai_provider — no surprise migration of existing accounts.

ALTER TABLE "users"
  ADD COLUMN "ai_provider_chain" JSONB;
