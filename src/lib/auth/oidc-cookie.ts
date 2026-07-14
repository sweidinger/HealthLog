/**
 * Shared between `/api/auth/oidc/login` (writer) and `/api/auth/oidc/callback`
 * (reader) — the encrypted, single-use blob carrying `{state, nonce,
 * codeVerifier, next}` across the browser round-trip to the IdP and back.
 */
export const OIDC_STATE_COOKIE = "oidc_auth_state";
/**
 * RFC 6265 keys a cookie by (name, domain, path) — a delete must repeat the
 * exact path the set used or it silently targets a different (non-existent)
 * cookie and the stale state blob survives. Every set AND delete goes
 * through this constant.
 */
export const OIDC_STATE_COOKIE_PATH = "/api/auth/oidc";
export const OIDC_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * MFA handoff between `/api/auth/oidc/callback` (writer) and the login page
 * (reader). When the OIDC account has a native second factor, the callback
 * mints the same single-use MFA ticket password login uses — but it ends on
 * a browser redirect, not a JSON response, so the ticket travels in this
 * short-lived, login-page-scoped cookie instead of an envelope `meta`.
 * Deliberately NOT httpOnly: the login page's script must read the ticket —
 * exactly the exposure the password flow already has, where the ticket
 * arrives in a JSON body read by the same script. The ticket alone carries
 * no session authority (single-use, hashed at rest, ~5-minute TTL,
 * attempt-capped — see `src/lib/auth/mfa/challenge.ts`).
 */
export const OIDC_MFA_COOKIE = "oidc_mfa_handoff";
export const OIDC_MFA_COOKIE_PATH = "/auth/login";
/** Mirrors MFA_CHALLENGE_TTL_MS — the cookie dies with the ticket. */
export const OIDC_MFA_TTL_MS = 5 * 60 * 1000;
