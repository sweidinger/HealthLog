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
 *
 * The localhost fallback is gated: it is offered in development, and in
 * production ONLY when neither app URL is configured — otherwise a production
 * deployment accepted an assertion whose `clientDataJSON.origin` was
 * `http://localhost:3000`. The signed `rpIdHash` still pins the real domain via
 * `getRpId()`, so this was defence-in-depth rather than a live bypass, but a
 * configured production origin has no reason to carry localhost at all. The
 * unconfigured case keeps the fallback so `getRpId()` still resolves instead of
 * throwing on an empty candidate list.
 */

/** Human-readable relying-party name shown by the authenticator UI. */
export const RP_NAME = "HealthLog";

export function getConfiguredOrigins(): string[] {
  const configured = [process.env.APP_URL, process.env.NEXT_PUBLIC_APP_URL]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  const allowLocalhost =
    process.env.NODE_ENV !== "production" || configured.length === 0;

  const candidates = allowLocalhost
    ? [...configured, "http://localhost:3000"]
    : configured;

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
