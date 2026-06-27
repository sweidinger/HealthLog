import { describe, it, expect, vi, beforeEach } from "vitest";

// Mirrors require-auth-bearer.test.ts mocking so the api-handler module loads
// without a live DB / request scope.
vi.mock("@/lib/db", () => ({
  prisma: {
    session: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/auth/hmac", () => ({ hashToken: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

const headersGet = vi.fn<(name: string) => string | null>();
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: headersGet })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import {
  requireFreshMfa,
  StepUpRequiredError,
  HttpError,
  MFA_STEP_UP_MAX_AGE_SECONDS,
} from "../api-handler";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

const MFA_USER = {
  id: "user-1",
  role: "USER" as const,
  username: "u",
  totpConfirmedAt: new Date("2020-01-01"),
};

beforeEach(() => {
  vi.resetAllMocks();
});

function mockSession(user: unknown) {
  vi.mocked(getSession).mockResolvedValue({
    session: { id: "sess-1", expiresAt: new Date(Date.now() + 1e6) },
    user,
  } as never);
}

describe("requireFreshMfa", () => {
  it("passes for a cookie session verified within the window", async () => {
    mockSession(MFA_USER);
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      mfaVerifiedAt: new Date(Date.now() - 60_000), // 1 min ago
    } as never);

    const ctx = await requireFreshMfa(MFA_STEP_UP_MAX_AGE_SECONDS);
    expect(ctx.user.id).toBe("user-1");
    expect(ctx.mfaVerifiedAt).toBeInstanceOf(Date);
  });

  it("rejects a stale verification (outside the window)", async () => {
    mockSession(MFA_USER);
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      mfaVerifiedAt: new Date(Date.now() - 10 * 60_000), // 10 min ago
    } as never);

    await expect(requireFreshMfa(5 * 60)).rejects.toMatchObject({
      name: "StepUpRequiredError",
      errorCode: "auth.stepup.required",
      statusCode: 401,
    });
  });

  it("rejects an absent verification stamp", async () => {
    mockSession(MFA_USER);
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      mfaVerifiedAt: null,
    } as never);

    await expect(requireFreshMfa(5 * 60)).rejects.toBeInstanceOf(
      StepUpRequiredError,
    );
  });

  it("rejects a user without an active second factor", async () => {
    mockSession({ ...MFA_USER, totpConfirmedAt: null });
    await expect(requireFreshMfa(5 * 60)).rejects.toMatchObject({
      errorCode: "auth.stepup.mfa_not_enrolled",
    });
    // Never even reaches the session-row read.
    expect(prisma.session.findUnique).not.toHaveBeenCalled();
  });

  it("rejects when there is no cookie session — Bearer can never satisfy it", async () => {
    // getSession is cookie-only; a Bearer header is irrelevant and never read.
    headersGet.mockImplementation((n) =>
      n.toLowerCase() === "authorization" ? "Bearer hlk_xyz" : null,
    );
    vi.mocked(getSession).mockResolvedValue(null as never);

    await expect(requireFreshMfa(5 * 60)).rejects.toBeInstanceOf(HttpError);
    expect(prisma.session.findUnique).not.toHaveBeenCalled();
  });
});
