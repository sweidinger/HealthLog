/**
 * TOTP (RFC 6238) second-factor primitives.
 *
 * Thin wrapper over `otpauth` (zero runtime deps) pinning the de-facto
 * interop floor — **SHA-1, 6 digits, 30-second period** — because
 * SHA-256/512 break the common authenticator apps and hardware tokens.
 * Drift window is **±1 step** (previous / current / next), the RFC's
 * recommended bound; every extra step widens the replay surface.
 *
 * Replay protection (the commonly-omitted control) is enforced by the
 * caller via the monotonic last-step counter: `verifyTotp` resolves the
 * submitted code to its absolute time-step and returns it, and the caller
 * rejects any step that is not strictly greater than the persisted
 * `User.totpLastStep`. A captured code therefore dies the instant it is
 * accepted once, even while it is still inside its 30-second life.
 *
 * The shared secret never leaves this module as anything but Base32; the
 * `otpauth://` URI carries the secret and is built here only to hand to
 * the enrolling client — it is never logged or persisted.
 */
import * as OTPAuth from "otpauth";

export const TOTP_ISSUER = "HealthLog";
export const TOTP_ALGORITHM = "SHA1";
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
/** ±1 step (≈ ±30 s clock skew). Do not widen without cause. */
export const TOTP_WINDOW = 1;
/** 160-bit secret per OWASP MFA / NIST 800-63B (`size` is bytes). */
const TOTP_SECRET_BYTES = 20;

/**
 * Generate a fresh CSPRNG Base32 secret (160-bit). The returned string is
 * the only form persisted (AES-256-GCM encrypted) and reconstituted for
 * verification.
 */
export function generateTotpSecret(): string {
  return new OTPAuth.Secret({ size: TOTP_SECRET_BYTES }).base32;
}

/**
 * Build the `otpauth://totp/...` enrollment URI for a Base32 secret.
 * Issuer is the fixed app name; `account` is the user-facing label
 * (email or username). The URI carries the secret — hand it to the client,
 * never log or persist it.
 */
export function buildOtpauthUri(secretBase32: string, account: string): string {
  const totp = new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label: account,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  return totp.toString();
}

/** The absolute RFC 6238 time-step for a moment in time. */
export function currentTotpStep(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);
}

export interface TotpVerifyResult {
  /** True only when the code is in-window AND not a replay. */
  valid: boolean;
  /**
   * The absolute time-step the code resolved to (current step + drift
   * delta). Present whenever the code matched the secret in-window — even
   * when rejected as a replay — so the caller can log the reason. Persist
   * this as the new `totpLastStep` on a successful, non-replay accept.
   */
  step: number | null;
  /** True when the code matched in-window but its step was already used. */
  replay: boolean;
}

/**
 * Verify a 6-digit code against a Base32 secret with ±1 drift and
 * monotonic replay rejection.
 *
 * @param secretBase32 the user's stored TOTP secret
 * @param code         the submitted 6-digit code (non-digits → invalid)
 * @param lastStep     the user's persisted `totpLastStep` (null = none yet)
 * @param atMs         clock injection point for tests
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  lastStep: number | null,
  atMs: number = Date.now(),
): TotpVerifyResult {
  const normalised = code.trim();
  if (!/^\d{6}$/.test(normalised)) {
    return { valid: false, step: null, replay: false };
  }

  const totp = new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label: TOTP_ISSUER,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });

  // `validate` returns the signed step delta (e.g. -1, 0, +1) when the
  // code matches inside the window, or null when it does not. The compare
  // is over the numeric HOTP truncation, not a string equality on the
  // secret, so there is no early-exit timing oracle on the secret bytes.
  const delta = totp.validate({
    token: normalised,
    timestamp: atMs,
    window: TOTP_WINDOW,
  });

  if (delta === null) {
    return { valid: false, step: null, replay: false };
  }

  const step = currentTotpStep(atMs) + delta;

  // Monotonic replay guard: the resolved step must be strictly newer than
  // the last one we accepted. Reusing an already-burned step — even one
  // still inside its 30-second life — is rejected.
  if (lastStep !== null && step <= lastStep) {
    return { valid: false, step, replay: true };
  }

  return { valid: true, step, replay: false };
}
