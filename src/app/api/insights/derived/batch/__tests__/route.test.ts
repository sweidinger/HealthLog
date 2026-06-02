import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        dateOfBirth: new Date("1986-01-01"),
        gender: "MALE",
        heightCm: 180,
      }),
    },
  },
}));

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

// Stub the compute layer; keep the real registry + loadBaselineProfile.
vi.mock("@/lib/insights/derived", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/insights/derived")>();
  return {
    ...actual,
    computeDerivedMetric: vi.fn(async (args: { metric: string }) => ({
      status: "ok",
      value: { metric: args.metric, n: 1 },
      coverage: { requiredInputs: 1, presentInputs: 1, historyDays: 30, missing: [] },
      confidence: { score: 100, band: "high" },
      provenance: { inputs: [], source: "DAY", windowDays: 30, computedAt: "2026-06-02T07:00:00+02:00" },
    })),
  };
});

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { computeDerivedMetric } from "@/lib/insights/derived";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const, locale: "en" },
};

const callGet = GET as unknown as (req: NextRequest) => Promise<Response>;
function makeReq(metrics?: string): NextRequest {
  const url = new URL("http://localhost/api/insights/derived/batch");
  if (metrics !== undefined) url.searchParams.set("metrics", metrics);
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    dateOfBirth: new Date("1986-01-01"),
    gender: "MALE",
    heightCm: 180,
  } as never);
});

describe("GET /api/insights/derived/batch", () => {
  it("resolves several metrics into one keyed map", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(
      makeReq("READINESS,BMI,VITALS_BASELINE:WEIGHT"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { metrics: Record<string, { metric: string; status: string }> };
      error: string | null;
    };
    expect(body.error).toBeNull();
    expect(Object.keys(body.data.metrics).sort()).toEqual([
      "BMI",
      "READINESS",
      "VITALS_BASELINE:WEIGHT",
    ]);
    expect(body.data.metrics["VITALS_BASELINE:WEIGHT"].status).toBe("ok");
    expect(body.data.metrics.READINESS.metric).toBe("READINESS");
  });

  it("loads the profile once regardless of metric count", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    await callGet(makeReq("READINESS,BMI,FITNESS_AGE,HRV_BALANCE"));
    // One User read for the whole batch — the pool-contention mitigation.
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(computeDerivedMetric).toHaveBeenCalledTimes(4);
  });

  it("narrows userId from the session into every compute call", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    await callGet(makeReq("READINESS"));
    expect(computeDerivedMetric).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", metric: "READINESS" }),
    );
  });

  it("collapses a duplicate token so it cannot inflate the fan-out", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    await callGet(makeReq("BMI,BMI,BMI"));
    expect(computeDerivedMetric).toHaveBeenCalledTimes(1);
  });

  it("422s when any token is an unknown metric id", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq("READINESS,NOT_A_METRIC"));
    expect(res.status).toBe(422);
    expect(computeDerivedMetric).not.toHaveBeenCalled();
  });

  it("422s on a missing metrics param", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(422);
    expect(computeDerivedMetric).not.toHaveBeenCalled();
  });

  it("422s on an empty metrics list", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq(" , , "));
    expect(res.status).toBe(422);
    expect(computeDerivedMetric).not.toHaveBeenCalled();
  });

  it("401s when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await callGet(makeReq("READINESS"));
    expect(res.status).toBe(401);
  });
});
