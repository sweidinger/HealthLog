import { describe, it, expect } from "vitest";
import * as OTPAuth from "otpauth";
import {
  generateTotpSecret,
  buildOtpauthUri,
  verifyTotp,
  currentTotpStep,
  TOTP_PERIOD_SECONDS,
} from "../totp";

/** Compute the canonical code a compliant authenticator would show at `atMs`. */
function codeAt(secretBase32: string, atMs: number): string {
  const totp = new OTPAuth.TOTP({
    issuer: "HealthLog",
    label: "HealthLog",
    algorithm: "SHA1",
    digits: 6,
    period: TOTP_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  return totp.generate({ timestamp: atMs });
}

const PERIOD_MS = TOTP_PERIOD_SECONDS * 1000;

describe("totp", () => {
  it("generates a Base32 secret and a parseable otpauth URI", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    const uri = buildOtpauthUri(secret, "user@example.com");
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain("issuer=HealthLog");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    // Round-trips back to the same secret.
    const parsed = OTPAuth.URI.parse(uri) as OTPAuth.TOTP;
    expect(parsed.secret.base32).toBe(secret);
  });

  it("accepts the current code and reports its step", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const res = verifyTotp(secret, codeAt(secret, now), null, now);
    expect(res.valid).toBe(true);
    expect(res.replay).toBe(false);
    expect(res.step).toBe(currentTotpStep(now));
  });

  it("rejects a wrong code and a non-numeric code", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, "000000", null, now).valid).toBe(false);
    expect(verifyTotp(secret, "abcdef", null, now).valid).toBe(false);
    expect(verifyTotp(secret, "12345", null, now).valid).toBe(false); // too short
  });

  it("accepts the previous and next step within the ±1 drift window", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_400_000;
    const prev = codeAt(secret, now - PERIOD_MS);
    const next = codeAt(secret, now + PERIOD_MS);
    expect(verifyTotp(secret, prev, null, now).valid).toBe(true);
    expect(verifyTotp(secret, next, null, now).valid).toBe(true);
  });

  it("rejects a code two steps away (outside the window)", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_400_000;
    const twoBack = codeAt(secret, now - 2 * PERIOD_MS);
    expect(verifyTotp(secret, twoBack, null, now).valid).toBe(false);
  });

  it("rejects replay of an already-accepted step (monotonic guard)", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const code = codeAt(secret, now);
    const first = verifyTotp(secret, code, null, now);
    expect(first.valid).toBe(true);
    const step = first.step as number;

    // Same code, now with lastStep recorded — must be rejected as a replay
    // even though it is still inside its 30-second life.
    const second = verifyTotp(secret, code, step, now);
    expect(second.valid).toBe(false);
    expect(second.replay).toBe(true);
    expect(second.step).toBe(step);
  });

  it("rejects a still-valid older step once a newer one was accepted", () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_400_000;
    const prevCode = codeAt(secret, now - PERIOD_MS);
    const prevStep = currentTotpStep(now) - 1;
    // The previous-step code is in-window but its step <= lastStep (current).
    const res = verifyTotp(secret, prevCode, currentTotpStep(now), now);
    expect(res.valid).toBe(false);
    expect(res.replay).toBe(true);
    expect(res.step).toBe(prevStep);
  });
});
