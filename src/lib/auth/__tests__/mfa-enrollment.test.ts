import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn() },
    webauthnMfaCredential: { count: vi.fn() },
    passkey: { count: vi.fn() },
  },
}));

vi.mock("@/lib/auth/secure-cookie", () => ({
  shouldEmitSecureCookie: () => true,
}));

const cookieStore = { set: vi.fn(), delete: vi.fn(), get: vi.fn() };
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieStore),
}));

import { resolveMfaEnrollmentRequired } from "../mfa-enrollment";
import { prisma } from "@/lib/db";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
    mfaRequired: false,
  } as never);
  vi.mocked(prisma.webauthnMfaCredential.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.passkey.count).mockResolvedValue(0 as never);
});

describe("resolveMfaEnrollmentRequired", () => {
  it("returns false (and skips all DB reads) for an account with confirmed TOTP", async () => {
    const required = await resolveMfaEnrollmentRequired("u1", {
      totpConfirmedAt: new Date(),
      mfaEnforced: true,
    });
    expect(required).toBe(false);
    expect(prisma.appSettings.findUnique).not.toHaveBeenCalled();
    expect(prisma.webauthnMfaCredential.count).not.toHaveBeenCalled();
  });

  it("returns false when no policy applies, even for a factor-less account", async () => {
    const required = await resolveMfaEnrollmentRequired("u1", {
      totpConfirmedAt: null,
      mfaEnforced: false,
    });
    expect(required).toBe(false);
    // Policy off short-circuits before counting factors.
    expect(prisma.webauthnMfaCredential.count).not.toHaveBeenCalled();
  });

  it("forces enrollment under the instance policy for a factor-less account", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      mfaRequired: true,
    } as never);
    const required = await resolveMfaEnrollmentRequired("u1", {
      totpConfirmedAt: null,
      mfaEnforced: false,
    });
    expect(required).toBe(true);
  });

  it("forces enrollment under a per-user override even with the instance policy off", async () => {
    const required = await resolveMfaEnrollmentRequired("u1", {
      totpConfirmedAt: null,
      mfaEnforced: true,
    });
    expect(required).toBe(true);
  });

  it("lets a registered security key satisfy the policy", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      mfaRequired: true,
    } as never);
    vi.mocked(prisma.webauthnMfaCredential.count).mockResolvedValue(1 as never);
    const required = await resolveMfaEnrollmentRequired("u1", {
      totpConfirmedAt: null,
      mfaEnforced: false,
    });
    expect(required).toBe(false);
  });

  it("lets a primary passkey satisfy the policy", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      mfaRequired: true,
    } as never);
    vi.mocked(prisma.passkey.count).mockResolvedValue(1 as never);
    const required = await resolveMfaEnrollmentRequired("u1", {
      totpConfirmedAt: null,
      mfaEnforced: false,
    });
    expect(required).toBe(false);
  });
});
