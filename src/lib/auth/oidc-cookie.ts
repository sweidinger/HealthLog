/**
 * Shared between `/api/auth/oidc/login` (writer) and `/api/auth/oidc/callback`
 * (reader) — the encrypted, single-use blob carrying `{state, nonce,
 * codeVerifier, next}` across the browser round-trip to the IdP and back.
 */
export const OIDC_STATE_COOKIE = "oidc_auth_state";
export const OIDC_STATE_TTL_MS = 10 * 60 * 1000;
