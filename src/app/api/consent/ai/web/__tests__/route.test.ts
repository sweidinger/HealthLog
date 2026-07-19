import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

// The mint logic + its TOCTOU close are covered by web-grant.test.ts; the
// route test stubs it to focus on auth + rate-limit + serialisation.
vi.mock("@/lib/consent/web-grant", () => ({
  ensureWebAiConsentReceipt: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkConsentRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(() => ({})),
}));

import { POST } from "../route";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { ensureWebAiConsentReceipt } from "@/lib/consent/web-grant";
import { checkConsentRateLimit } from "@/lib/rate-limit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

const RL_OK = { allowed: true, remaining: 19, resetAt: Date.now() + 60_000 };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(auditLog).mockResolvedValue(undefined);
  vi.mocked(checkConsentRateLimit).mockResolvedValue(RL_OK);
});

describe("POST /api/consent/ai/web", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(401);
    expect(ensureWebAiConsentReceipt).not.toHaveBeenCalled();
  });

  it("returns 429 when the per-user consent bucket is exhausted", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkConsentRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await POST();
    expect(res.status).toBe(429);
    // The throttle fires before the heal mint runs.
    expect(ensureWebAiConsentReceipt).not.toHaveBeenCalled();
  });

  it("mints a receipt and reports minted:true", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(ensureWebAiConsentReceipt).mockResolvedValue({
      minted: true,
      receipt: { id: "rcpt-web-1" } as never,
    });

    const res = await POST();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { minted: boolean; kind: string };
    };
    expect(body.data.minted).toBe(true);
    expect(body.data.kind).toBe("ai_full");
  });

  it("is a no-op when an active receipt already exists (minted:false)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(ensureWebAiConsentReceipt).mockResolvedValue({
      minted: false,
      reason: "already_active",
    });

    const res = await POST();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { minted: boolean } };
    expect(body.data.minted).toBe(false);
    // No audit row on the no-op path.
    expect(auditLog).not.toHaveBeenCalled();
  });
});
