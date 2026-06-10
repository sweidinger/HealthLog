/**
 * POST /api/cycle/day-logs/bulk — body-size cap.
 *
 * The bulk drain accepts up to 500 entries; the `safeJson` cap (2 MB)
 * rejects an oversized body with 413 before `JSON.parse` builds an
 * object graph.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/idempotency", () => ({
  withIdempotency:
    <Args extends unknown[]>(fn: (...args: Args) => Promise<Response>) =>
    (...args: Args) =>
      fn(...args),
}));
vi.mock("@/lib/cycle/gate", () => ({
  requireCycleEnabled: vi.fn(),
}));
vi.mock("@/lib/cycle/day-log-write", () => ({
  upsertCycleDayLog: vi.fn(),
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

import { POST } from "../route";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import { upsertCycleDayLog } from "@/lib/cycle/day-log-write";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/cycle/day-logs/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(requireCycleEnabled).mockResolvedValue({
    enabled: true,
  } as never);
});

describe("POST /api/cycle/day-logs/bulk — body cap", () => {
  it("rejects a body over the 2 MB cap with 413 before parsing", async () => {
    const res = await POST(
      postReq({ entries: [], pad: "x".repeat(2 * 1024 * 1024) }),
    );
    expect(res.status).toBe(413);
    expect(upsertCycleDayLog).not.toHaveBeenCalled();
  });

  it("still rejects an over-cap entries array with 422 below the byte cap", async () => {
    const entries = Array.from({ length: 501 }, (_, i) => ({
      date: "2026-01-01",
      externalId: `e${i}`,
    }));
    const res = await POST(postReq({ entries }));
    expect(res.status).toBe(422);
    expect(upsertCycleDayLog).not.toHaveBeenCalled();
  });
});
