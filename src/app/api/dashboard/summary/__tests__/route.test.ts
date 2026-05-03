import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/logging/transports", () => ({
  emitIfSampled: vi.fn(),
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({ get: () => undefined, set: () => {}, delete: () => {} })),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "marc",
    role: "USER" as const,
    displayName: null,
  },
};

// `apiHandler` always reads `request.url` — even when the inner handler
// ignores it — so we hand it a NextRequest and bypass the inner-handler
// arity check via a cast.
const callGet = GET as unknown as (req: NextRequest) => Promise<Response>;
function makeReq(): NextRequest {
  return new NextRequest("http://localhost/api/dashboard/summary");
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([] as never);
});

describe("GET /api/dashboard/summary", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await callGet(makeReq());
    expect(res.status).toBe(401);
  });

  it("returns the aggregated payload with empty data", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        greeting: { salutation: string; date: string };
        streak: { currentDays: number; longest: number; label: string };
        compliance: { scheduledToday: number; takenToday: number };
        metrics: Array<{ id: string; kind: string; sparkline: number[] }>;
      };
    };
    expect(body.data.greeting.salutation).toBe("Hi, marc");
    expect(body.data.streak.currentDays).toBe(0);
    expect(body.data.compliance.scheduledToday).toBe(0);
    expect(body.data.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "weight" }),
        expect.objectContaining({ id: "bp" }),
        expect.objectContaining({ id: "pulse" }),
      ]),
    );
  });

  it("computes intake compliance for today", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockImplementation(((
      args: unknown,
    ) => {
      const a = args as { where: { OR?: unknown } };
      if (!a.where.OR) {
        return Promise.resolve([
          { id: "e1", takenAt: new Date(), skipped: false },
          { id: "e2", takenAt: null, skipped: false },
        ]) as never;
      }
      return Promise.resolve([]) as never;
    }) as never);
    const res = await callGet(makeReq());
    const body = (await res.json()) as {
      data: { compliance: { scheduledToday: number; takenToday: number } };
    };
    expect(body.data.compliance.scheduledToday).toBe(2);
    expect(body.data.compliance.takenToday).toBe(1);
  });
});
