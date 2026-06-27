/**
 * PKCE (RFC 7636) — S256 only.
 *
 * Both Claude.ai and ChatGPT send `code_challenge_method=S256` on every
 * authorization request, and the AS advertises ONLY `S256` in
 * `code_challenge_methods_supported`. The `plain` method is structurally
 * unsupported here — a missing or non-S256 challenge is rejected at `/authorize`,
 * and a verifier that does not hash to the bound challenge is rejected at
 * `/token`. PKCE is therefore mandatory on the whole authorization-code flow.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** Base64url-encode without padding (the PKCE wire form). */
function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** The S256 transform: BASE64URL(SHA256(ASCII(verifier))). */
export function s256Challenge(verifier: string): string {
  return b64url(createHash("sha256").update(verifier, "ascii").digest());
}

/** RFC 7636 §4.1 — verifier is 43–128 chars of the unreserved set. */
export function isValidVerifier(verifier: unknown): verifier is string {
  return (
    typeof verifier === "string" && /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)
  );
}

/** A non-empty challenge string (the exact length is the client's concern). */
export function isValidChallenge(challenge: unknown): challenge is string {
  return (
    typeof challenge === "string" &&
    challenge.length >= 43 &&
    challenge.length <= 128
  );
}

/**
 * Constant-time check that `verifier` hashes (S256) to `challenge`. Returns
 * false for any malformed input rather than throwing.
 */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!isValidVerifier(verifier) || !isValidChallenge(challenge)) {
    return false;
  }
  const computed = Buffer.from(s256Challenge(verifier));
  const expected = Buffer.from(challenge);
  return (
    computed.length === expected.length && timingSafeEqual(computed, expected)
  );
}
