/**
 * The single source of truth for the Argon2id hashing parameters.
 *
 * Both the application's `hashPassword()` (src/lib/auth/password.ts) and the
 * operator password-reset CLI (scripts/reset-password.mjs) import these exact
 * options so a hash minted from the container matches one minted by the running
 * app byte-for-byte. The CLI must run under plain `node` inside the production
 * standalone image (which strips `tsx` and cannot import the TS client), so the
 * shared params live in a plain `.mjs` module that both an ESM `node` process
 * and the bundled TypeScript app can import.
 *
 * Do not fork these values. Changing them changes the verifier cost for every
 * new hash; existing stored hashes carry their own parameters in the encoded
 * string and keep verifying regardless.
 *
 * @type {{ memoryCost: number; timeCost: number; outputLen: number; parallelism: number }}
 */
export const ARGON2_HASH_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  outputLen: 32,
  parallelism: 1,
};
