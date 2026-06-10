import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify HMAC-SHA256 signature for external ingest.
 * Signature format: "sha256=<hex>"
 * The signature is computed over the raw request body using the API token as the key.
 */
export function verifyHmacSignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  const prefix = "sha256=";
  if (!signature.startsWith(prefix)) return false;

  const receivedHex = signature.slice(prefix.length);
  const expectedHex = createHmac("sha256", secret).update(body).digest("hex");

  try {
    return timingSafeEqual(
      Buffer.from(receivedHex, "hex"),
      Buffer.from(expectedHex, "hex"),
    );
  } catch {
    return false;
  }
}

/**
 * Hash an API token for storage (SHA-256).
 * Requires API_TOKEN_HMAC_KEY env var to be set and at least 32
 * characters long. Fail-closed like the encryption-key loader in
 * `src/lib/crypto.ts`: a weak key throws instead of silently keying
 * every Bearer-token hash off guessable material.
 */
const MIN_HMAC_KEY_LENGTH = 32;

export function hashToken(token: string): string {
  const key = process.env.API_TOKEN_HMAC_KEY;
  if (!key) {
    throw new Error("API_TOKEN_HMAC_KEY env var must be set");
  }
  if (key.length < MIN_HMAC_KEY_LENGTH) {
    throw new Error(
      `API_TOKEN_HMAC_KEY must be at least ${MIN_HMAC_KEY_LENGTH} characters, got ${key.length}. ` +
        "Generate a strong key with `openssl rand -hex 32` and update the environment before restarting.",
    );
  }
  return createHmac("sha256", key).update(token).digest("hex");
}
