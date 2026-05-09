/**
 * Re-export pin for the seeded test-user identity. The cookie jar that
 * authenticates each spec is captured ONCE in `global-setup.ts` and the
 * specs reach for it via `STORAGE_STATE_PATH` directly. We keep this
 * file (instead of a barrel inside global-setup) only so future helpers
 * specific to the spec-side (e.g. multi-user scenarios that need
 * fresh logins) have a natural home.
 */
export { E2E_USER, STORAGE_STATE_PATH } from "./global-setup";
