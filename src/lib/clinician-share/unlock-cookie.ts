/**
 * v1.18.7 — short-lived unlock cookie for a passphrase-gated share link.
 *
 * After the public unlock route verifies the passphrase it mints a signed,
 * httpOnly, SameSite=Strict, Secure (per `shouldEmitSecureCookie`) cookie
 * SCOPED to that one token's view path (`/c/<token>`). The page checks the
 * cookie server-side before rendering the record; presenting an unlock for one
 * token never unlocks another (the cookie name + path both pin the token hash).
 *
 * The value is opaque and self-verifying: `<expiryMs>.<hmac>` where the HMAC is
 * over `"<tokenHash>.<expiryMs>"` keyed by `API_TOKEN_HMAC_KEY`. No server-side
 * session row is needed; a forged or replayed-across-token value fails the
 * constant-time HMAC check, and an expired one fails the timestamp check. TTL
 * is short (30 min) so a shared device window closes quickly.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Unlock-cookie lifetime: 30 minutes. */
export const UNLOCK_TTL_SECONDS = 30 * 60;

const MIN_HMAC_KEY_LENGTH = 32;

function unlockKey(): string {
  const key = process.env.API_TOKEN_HMAC_KEY;
  if (!key) {
    throw new Error("API_TOKEN_HMAC_KEY env var must be set");
  }
  if (key.length < MIN_HMAC_KEY_LENGTH) {
    throw new Error(
      `API_TOKEN_HMAC_KEY must be at least ${MIN_HMAC_KEY_LENGTH} characters, got ${key.length}.`,
    );
  }
  return key;
}

/**
 * The per-token cookie name. A short prefix of the token hash keeps cookies for
 * different shares distinct without putting the full hash in the header. The
 * path scoping (`/c/<token>`) is the real isolation boundary; the name suffix
 * only avoids cross-token collisions inside the same browser.
 */
export function unlockCookieName(tokenHash: string): string {
  return `hls_unlock_${tokenHash.slice(0, 16)}`;
}

function sign(tokenHash: string, expiryMs: number): string {
  return createHmac("sha256", unlockKey())
    .update(`${tokenHash}.${expiryMs}`)
    .digest("hex");
}

/** Mint a fresh unlock-cookie value bound to this token hash. */
export function mintUnlockValue(tokenHash: string): string {
  const expiryMs = Date.now() + UNLOCK_TTL_SECONDS * 1000;
  return `${expiryMs}.${sign(tokenHash, expiryMs)}`;
}

/**
 * Verify an unlock-cookie value against the token hash. Constant-time on the
 * HMAC; returns false for any malformed, forged, cross-token, or expired value.
 */
export function verifyUnlockValue(
  value: string | undefined,
  tokenHash: string,
): boolean {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const expiryMs = Number(value.slice(0, dot));
  if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) return false;
  const received = value.slice(dot + 1);
  const expected = sign(tokenHash, expiryMs);
  const a = Buffer.from(received, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
