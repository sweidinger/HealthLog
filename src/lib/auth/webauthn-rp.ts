/**
 * Shared WebAuthn relying-party configuration.
 *
 * Both the passwordless-primary passkey path (`src/lib/auth/passkey.ts`) and
 * the second-factor security-key path (`src/lib/auth/mfa/webauthn.ts`) resolve
 * the same relying-party id / origin from the deployment's configured app URL,
 * so the two ceremonies always agree on the RP they bind credentials to.
 *
 * The candidates mirror the rest of the app: `APP_URL` first, then the public
 * build-time URL, then a localhost fallback for dev. A multi-origin deployment
 * (rare for a single-tenant self-host, but supported) passes the whole set to
 * SimpleWebAuthn's `expectedOrigin`.
 */

/** Human-readable relying-party name shown by the authenticator UI. */
export const RP_NAME = "HealthLog";

export function getConfiguredOrigins(): string[] {
  const candidates = [
    process.env.APP_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    "http://localhost:3000",
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  const validOrigins = candidates
    .map((value) => {
      try {
        return new URL(value).origin;
      } catch {
        return null;
      }
    })
    .filter((value): value is string => Boolean(value));

  return Array.from(new Set(validOrigins));
}

export function getRpId(): string {
  const origins = getConfiguredOrigins();
  return new URL(origins[0]).hostname;
}

export function getExpectedOrigin(): string | string[] {
  const origins = getConfiguredOrigins();
  return origins.length === 1 ? origins[0] : origins;
}
