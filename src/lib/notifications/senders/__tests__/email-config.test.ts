/**
 * SMTP config loader unit tests (v1.17.1). Mirrors the APNs env-gating
 * contract: zero set → disabled (no warning), partial set → disabled (warning),
 * all three core vars → configured. SMTP_USER/SMTP_PASS are optional.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({ addWarning: vi.fn() }),
}));

import {
  loadEmailConfig,
  isEmailConfigured,
  resetEmailConfigForTesting,
} from "../email-config";

const ORIGINAL_ENV = { ...process.env };

function clearSmtp() {
  for (const key of [
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_FROM",
    "SMTP_USER",
    "SMTP_PASS",
    "SMTP_SECURE",
  ]) {
    delete process.env[key];
  }
}

beforeEach(() => {
  clearSmtp();
  resetEmailConfigForTesting();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetEmailConfigForTesting();
});

describe("loadEmailConfig", () => {
  it("returns null when nothing is set", () => {
    expect(loadEmailConfig()).toBeNull();
    expect(isEmailConfigured()).toBe(false);
  });

  it("returns null when only some core vars are set (partial)", () => {
    process.env.SMTP_HOST = "smtp.example.com";
    resetEmailConfigForTesting();
    expect(loadEmailConfig()).toBeNull();
  });

  it("builds a config from the three core vars (no auth)", () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "587";
    process.env.SMTP_FROM = "noreply@example.com";
    resetEmailConfigForTesting();

    const config = loadEmailConfig();
    expect(config).toEqual({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      from: "noreply@example.com",
    });
    expect(isEmailConfigured()).toBe(true);
  });

  it("includes auth when user + pass are set and honours SMTP_SECURE", () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "465";
    process.env.SMTP_FROM = "noreply@example.com";
    process.env.SMTP_USER = "u";
    process.env.SMTP_PASS = "p";
    process.env.SMTP_SECURE = "true";
    resetEmailConfigForTesting();

    const config = loadEmailConfig();
    expect(config?.secure).toBe(true);
    expect(config?.auth).toEqual({ user: "u", pass: "p" });
  });
});
