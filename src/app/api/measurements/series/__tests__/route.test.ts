import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: { measurement: { findMany: vi.fn() } },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

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
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

function req(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/measurements/series?${query}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
});

describe("GET /api/measurements/series", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await GET(req("kind=weight"));
    expect(res.status).toBe(401);
  });

  it("returns 422 for invalid kind", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(req("kind=garbage"));
    expect(res.status).toBe(422);
  });

  it("returns paired BP series with sys + dia", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const t = new Date("2026-05-01T10:00:00.000Z");
    const findManyMock = vi.mocked(prisma.measurement.findMany);
    findManyMock.mockImplementation(((args: unknown) => {
      const a = args as { where: { type: string } };
      if (a.where.type === "BLOOD_PRESSURE_SYS") {
        return Promise.resolve([
          { id: "s1", value: 126, measuredAt: t },
        ]) as never;
      }
      if (a.where.type === "BLOOD_PRESSURE_DIA") {
        return Promise.resolve([
          {
            id: "d1",
            value: 82,
            measuredAt: new Date(t.getTime() + 60_000),
          },
        ]) as never;
      }
      return Promise.resolve([]) as never;
    }) as never);
    const res = await GET(req("kind=bloodPressure&days=30"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        kind: string;
        points: Array<{ value: number; secondary: number | null }>;
        stats: { count: number };
      };
    };
    expect(body.data.kind).toBe("bloodPressure");
    expect(body.data.points).toHaveLength(1);
    expect(body.data.points[0].value).toBe(126);
    expect(body.data.points[0].secondary).toBe(82);
    expect(body.data.stats.count).toBe(1);
  });

  it("returns single-value series for kind=weight", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { id: "w1", value: 78.4, measuredAt: new Date() },
    ] as never);
    const res = await GET(req("kind=weight&days=7"));
    const body = (await res.json()) as {
      data: { points: Array<{ secondary: number | null }> };
    };
    expect(body.data.points[0].secondary).toBeNull();
  });
});
