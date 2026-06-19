/**
 * v1.18.7 — clinician share-link passphrase second factor.
 *
 * A share URL is now possession AND knowledge: a leaked `/c/<token>` link
 * without the passphrase cannot open the record. Every new link gets a
 * high-entropy passphrase minted here, returned to the owner EXACTLY ONCE,
 * and stored only as its HMAC-SHA256 hash (the same `hashToken` scheme as the
 * token itself, keyed by `API_TOKEN_HMAC_KEY`). There is no recovery path.
 *
 * Shape: 16 Crockford-base32 characters grouped `XXXX-XXXX-XXXX-XXXX`. The raw
 * 16 chars carry 80 bits of entropy; we draw them from 10 random bytes (80
 * bits) so the human-typeable form is the full secret with no truncation. The
 * QR payload (built by the create route) carries this in the URL FRAGMENT so it
 * never reaches a server log, referrer, or access record.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

import { hashToken } from "@/lib/auth/hmac";

/**
 * Crockford base32 alphabet (no I/L/O/U — removes the characters most often
 * misread when typed by hand). 32 symbols → 5 bits each.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Group size for the human-typeable form (`XXXX-XXXX-XXXX-XXXX`). */
const GROUP = 4;
/** Total characters in a raw passphrase (16 × 5 bits = 80 bits). */
const LENGTH = 16;

/** The fragment key the QR / deep-link uses: `#k=<passphrase>`. */
export const PASSPHRASE_FRAGMENT_KEY = "k";

/**
 * The canonical regex a submitted passphrase must match once normalised
 * (uppercased, separators stripped): 16 Crockford-base32 characters.
 */
export const PASSPHRASE_PATTERN = new RegExp(`^[${ALPHABET}]{${LENGTH}}$`);

/**
 * Generate a fresh passphrase in the grouped human-typeable form
 * (`XXXX-XXXX-XXXX-XXXX`). Drawn from CSPRNG bytes via rejection-free
 * masking — each character maps a 5-bit slice of the random stream onto the
 * 32-symbol alphabet, so the distribution is uniform.
 */
export function generatePassphrase(): string {
  // 16 chars × 5 bits = 80 bits → 10 bytes of entropy.
  const bytes = randomBytes(10);
  let bits = 0;
  let value = 0;
  const chars: string[] = [];
  for (let i = 0; i < bytes.length && chars.length < LENGTH; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5 && chars.length < LENGTH) {
      bits -= 5;
      chars.push(ALPHABET[(value >>> bits) & 0x1f]);
    }
  }
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += GROUP) {
    groups.push(chars.slice(i, i + GROUP).join(""));
  }
  return groups.join("-");
}

/**
 * Normalise a passphrase a human (or a QR fragment) submitted: strip every
 * separator / whitespace and uppercase. Lowercase `l`→`L` style confusions are
 * left to the alphabet (which already excludes I/L/O/U), so a value that does
 * not normalise to the canonical pattern is simply rejected by the caller.
 * Returns the bare 16-char form, or `null` when it does not match the pattern.
 */
export function normalisePassphrase(raw: string): string | null {
  const stripped = raw.replace(/[\s-]+/g, "").toUpperCase();
  return PASSPHRASE_PATTERN.test(stripped) ? stripped : null;
}

/**
 * Hash a passphrase for storage / comparison. Normalises first so the grouped
 * and bare forms collide to one hash; throws (via `normalisePassphrase` →
 * caller) only when the input is malformed. Returns the lowercase hex HMAC.
 */
export function hashPassphrase(normalised: string): string {
  return hashToken(normalised);
}

/**
 * Constant-time check of a submitted passphrase against a stored hash. Returns
 * false for a malformed submission, a null stored hash, or any mismatch — and
 * never short-circuits on length so timing leaks nothing about the secret.
 */
export function verifyPassphrase(
  submitted: string,
  storedHash: string | null,
): boolean {
  if (!storedHash) return false;
  const normalised = normalisePassphrase(submitted);
  if (!normalised) return false;
  const candidate = Buffer.from(hashPassphrase(normalised), "hex");
  const expected = Buffer.from(storedHash, "hex");
  if (candidate.length !== expected.length) return false;
  try {
    return timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}
