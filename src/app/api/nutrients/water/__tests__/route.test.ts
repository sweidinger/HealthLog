/**
 * v1.29 — `POST /api/nutrients/water` contract tests.
 *
 * Pins the manual quick-add posture: module gate first, rate limit,
 * `add` vs `set` upsert shape, the MANUAL-only key (never touches the
 * APPLE_HEALTH row), the local-day default, and the dashboard-snapshot
 * hard-evict on success.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    nutrientIntakeDay: {
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(),
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserDashboardSnapshot: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
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
import { prisma } from "@/lib/db";
import { apiError } from "@/lib/api-response";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { invalidateUserDashboardSnapshot } from "@/lib/cache/invalidate";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "tester",
    role: "USER" as const,
    timezone: "Europe/Berlin",
    gender: "FEMALE",
  },
};

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/nutrients/water", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface WaterResponse {
  data: {
    day: string;
    nutrient: string;
    source: string;
    amount: number;
    unit: string;
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true } as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 59,
    resetAt: Date.now() + 60_000,
  });
  vi.mocked(prisma.nutrientIntakeDay.upsert).mockResolvedValue({
    day: "2026-07-16",
    nutrient: "water",
    source: "MANUAL",
    amount: 500,
    unit: "ml",
  } as never);
});

describe("POST /api/nutrients/water", () => {
  it("refuses with the 403 module.disabled envelope when the module is off", async () => {
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: false,
      response: apiError('Module "nutrients" is not enabled', 403, {
        errorCode: "module.disabled",
        module: "nutrients",
      }),
    } as never);
    const res = await POST(postReq({ amountMl: 200, mode: "add" }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("module.disabled");
    expect(prisma.nutrientIntakeDay.upsert).not.toHaveBeenCalled();
  });

  it("returns 429 when the rate limit is exceeded", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await POST(postReq({ amountMl: 200, mode: "add" }));
    expect(res.status).toBe(429);
    expect(prisma.nutrientIntakeDay.upsert).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range or missing amountMl with 422", async () => {
    for (const bad of [
      { amountMl: 0, mode: "add" },
      { amountMl: -5, mode: "add" },
      { amountMl: 30000, mode: "add" },
      { mode: "add" },
    ]) {
      const res = await POST(postReq(bad));
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
  });

  it("rejects an unknown mode with 422", async () => {
    const res = await POST(postReq({ amountMl: 200, mode: "double" }));
    expect(res.status).toBe(422);
  });

  it("rejects a malformed day with 422 (calendar-invalid)", async () => {
    const res = await POST(
      postReq({ amountMl: 200, mode: "add", day: "2026-02-31" }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("nutrient.water.invalid_day");
  });

  it("add mode upserts the MANUAL row with an atomic increment — never the APPLE_HEALTH row", async () => {
    const res = await POST(
      postReq({ amountMl: 250, mode: "add", day: "2026-07-16" }),
    );
    expect(res.status).toBe(200);
    expect(prisma.nutrientIntakeDay.upsert).toHaveBeenCalledWith({
      where: {
        userId_day_nutrient_source: {
          userId: "user-1",
          day: "2026-07-16",
          nutrient: "water",
          source: "MANUAL",
        },
      },
      create: {
        userId: "user-1",
        day: "2026-07-16",
        nutrient: "water",
        amount: 250,
        unit: "ml",
        source: "MANUAL",
      },
      update: { amount: { increment: 250 } },
    });
    expect(invalidateUserDashboardSnapshot).toHaveBeenCalledWith("user-1");
  });

  it("set mode overwrites the MANUAL row's amount instead of incrementing", async () => {
    await POST(postReq({ amountMl: 1800, mode: "set", day: "2026-07-16" }));
    expect(prisma.nutrientIntakeDay.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { amount: 1800 } }),
    );
  });

  it("defaults `day` to the caller's current local day when omitted", async () => {
    await POST(postReq({ amountMl: 200, mode: "add" }));
    const call = vi.mocked(prisma.nutrientIntakeDay.upsert).mock
      .calls[0][0] as {
      where: { userId_day_nutrient_source: { day: string } };
    };
    expect(call.where.userId_day_nutrient_source.day).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });

  it("returns the MANUAL row shape on success", async () => {
    const res = await POST(
      postReq({ amountMl: 250, mode: "add", day: "2026-07-16" }),
    );
    const body = (await res.json()) as WaterResponse;
    expect(body.data).toEqual({
      day: "2026-07-16",
      nutrient: "water",
      source: "MANUAL",
      amount: 500,
      unit: "ml",
    });
  });
});
