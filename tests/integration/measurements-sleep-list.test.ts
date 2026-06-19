/**
 * v1.11.5 — SLEEP_DURATION list collapse.
 *
 * `GET /api/measurements?type=SLEEP_DURATION` is stored one row per stage
 * per night. The list route now collapses those raw stage rows into one
 * synthetic row per night (TIME ASLEEP), with a `dayKey` drill-down to the
 * night's stage segments. This locks the leak closure end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface ListEnvelope {
  data: {
    measurements: Array<{
      id: string;
      type: string;
      value: number;
      unit: string;
      dayKey?: string;
      sampleCount?: number;
      sleepStage?: string | null;
      napCount?: number;
      awakenings?: number;
    }>;
    meta: { total: number; groupBy?: string };
  };
}

async function seedSession(username: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: { username, email: `${username}@example.test`, role: "USER" },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

async function callList(query: string): Promise<Response> {
  const { GET } = await import("@/app/api/measurements/route");
  return GET(new NextRequest(`http://localhost/api/measurements?${query}`));
}

describe("GET /api/measurements?type=SLEEP_DURATION", () => {
  it("collapses raw stage rows into one row per night", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession("sleep-list-user");

    // Recent night so the trailing-year window includes it. Contiguous
    // stage rows ending this morning (Berlin default tz).
    const wakeBase = new Date();
    wakeBase.setUTCHours(4, 0, 0, 0);
    const seed = async (
      stage: "CORE" | "DEEP" | "REM",
      min: number,
      offsetMin: number,
    ) =>
      prisma.measurement.create({
        data: {
          userId: user.id,
          type: "SLEEP_DURATION",
          value: min,
          unit: "minutes",
          source: "APPLE_HEALTH",
          measuredAt: new Date(wakeBase.getTime() - offsetMin * 60_000),
          externalId: `uuid-${stage}`,
          sleepStage: stage,
        },
      });
    // CORE 240 (ends -180), DEEP 120 (ends -60), REM 60 (ends 0).
    await seed("CORE", 240, 180);
    await seed("DEEP", 120, 60);
    await seed("REM", 60, 0);

    const res = await callList("type=SLEEP_DURATION");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListEnvelope;
    // ONE per-night row, not three stage rows.
    expect(body.data.measurements).toHaveLength(1);
    const row = body.data.measurements[0];
    // value = TIME ASLEEP = 240 + 120 + 60 = 420 min.
    expect(row.value).toBe(420);
    expect(row.dayKey).toBeDefined();
    expect(body.data.meta.groupBy).toBe("night");
  });

  it("drills down to the night's stage segments via dayKey", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession("sleep-drill-user");

    const wakeBase = new Date();
    wakeBase.setUTCHours(4, 0, 0, 0);
    const seed = async (
      stage: "CORE" | "DEEP" | "REM",
      min: number,
      offsetMin: number,
    ) =>
      prisma.measurement.create({
        data: {
          userId: user.id,
          type: "SLEEP_DURATION",
          value: min,
          unit: "minutes",
          source: "APPLE_HEALTH",
          measuredAt: new Date(wakeBase.getTime() - offsetMin * 60_000),
          externalId: `uuid-${stage}`,
          sleepStage: stage,
        },
      });
    await seed("CORE", 240, 180);
    await seed("DEEP", 120, 60);
    await seed("REM", 60, 0);

    // First get the per-night row to learn its dayKey.
    const nightRes = await callList("type=SLEEP_DURATION");
    const nightBody = (await nightRes.json()) as ListEnvelope;
    const dayKey = nightBody.data.measurements[0].dayKey!;

    const res = await callList(`type=SLEEP_DURATION&dayKey=${dayKey}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListEnvelope;
    // The drill-down returns the three stage segments.
    expect(body.data.measurements).toHaveLength(3);
    const stages = body.data.measurements.map((m) => m.sleepStage).sort();
    expect(stages).toEqual(["CORE", "DEEP", "REM"]);
  });
});
