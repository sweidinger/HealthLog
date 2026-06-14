import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({
    user: { id: "u-1" },
    session: { id: "s-1" },
  })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { create: vi.fn(), upsert: vi.fn() },
    moodEntry: { create: vi.fn(), upsert: vi.fn() },
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

// v1.4.39.1 — surface the rollup hook so the new regression test can
// assert that the import path now folds the persistent rollup tier
// for each touched (type, day). Mood rollup mock stays no-op because
// the existing v1.4.39 W-MOOD hook already covers the moodlog branch.
vi.mock("@/lib/rollups/measurement-rollups", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/rollups/measurement-rollups")
  >("@/lib/rollups/measurement-rollups");
  return {
    ...actual,
    recomputeBucketsForMeasurement: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/rollups/mood-rollups", () => ({
  recomputeUserMoodRollups: vi.fn().mockResolvedValue(undefined),
}));

import { NextRequest } from "next/server";
import { POST } from "../route";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { recomputeBucketsForMeasurement } from "@/lib/rollups/measurement-rollups";

beforeEach(() => {
  vi.resetAllMocks();
});

interface ApiErrorEnvelope {
  data: null;
  error: string;
}

// V3 audit: /api/import POST had no rate-limit. Bulk-injection vector
// (max:10000 records per call). Now capped at 5/hour/user.
describe("POST /api/import — rate-limit guard", () => {
  it("returns 429 when the user has exhausted the 5/hour quota (HIGH coverage gap)", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 1000),
    } as never);

    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({ measurements: [] }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBe(429);
    const body = (await response.json()) as ApiErrorEnvelope;
    expect(body.error).toMatch(/per hour/i);
    expect(checkRateLimit).toHaveBeenCalledWith(
      expect.stringContaining("import:u-1"),
      5,
      60 * 60 * 1000,
    );
  });

  it("processes the request when within the quota", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 4,
      resetAt: new Date(Date.now() + 1000),
    } as never);

    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({ measurements: [] }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBeLessThan(400);
  });

  it("rejects a body over the 16 MB cap with 413 before parsing", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({
          measurements: [],
          pad: "x".repeat(16 * 1024 * 1024),
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(413);
  });

  it("returns the standard apiError envelope for invalid payloads", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 4,
      resetAt: new Date(Date.now() + 1000),
    } as never);

    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({ measurements: "not-an-array" }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as ApiErrorEnvelope;
    expect(body.data).toBeNull();
    expect(body.error).toBeTruthy();
  });
});

// v1.4.39.1 — the import path used to write measurements without
// firing the rollup hook, so the dashboard chart's `source=rollup`
// fast-path silently under-counted any imported days until the next
// worker boot ran the backfill discovery. Cover the wiring with a
// regression test so a future refactor can't silently drop it again.
describe("POST /api/import — measurement rollup hook (v1.4.39.1)", () => {
  it("folds the persistent rollup table for each (type, day) the import touched", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 4,
      resetAt: new Date(Date.now() + 1000),
    } as never);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({
          measurements: [
            {
              type: "BLOOD_PRESSURE_SYS",
              value: 124,
              unit: "mmHg",
              measuredAt: "2026-05-12T07:30:00.000Z",
            },
            {
              type: "BLOOD_PRESSURE_SYS",
              value: 121,
              unit: "mmHg",
              measuredAt: "2026-05-12T19:30:00.000Z",
            },
            {
              type: "BLOOD_PRESSURE_SYS",
              value: 119,
              unit: "mmHg",
              measuredAt: "2026-05-14T08:00:00.000Z",
            },
            {
              type: "WEIGHT",
              value: 82.4,
              unit: "kg",
              measuredAt: "2026-05-14T07:00:00.000Z",
            },
          ],
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBeLessThan(400);
    // Two BP rows on 2026-05-12 collapse to one rollup call; one BP
    // row on 2026-05-14 is its own call; one WEIGHT row on 2026-05-14
    // is a separate (type, day) pair. Total = 3 distinct rollup folds.
    expect(recomputeBucketsForMeasurement).toHaveBeenCalledTimes(3);
    const calls = vi
      .mocked(recomputeBucketsForMeasurement)
      .mock.calls.map((c) => `${c[1]}|${(c[2] as Date).toISOString()}`);
    expect(new Set(calls)).toEqual(
      new Set([
        "BLOOD_PRESSURE_SYS|2026-05-12T00:00:00.000Z",
        "BLOOD_PRESSURE_SYS|2026-05-14T00:00:00.000Z",
        "WEIGHT|2026-05-14T00:00:00.000Z",
      ]),
    );
  });

  it("does not call the rollup hook when no measurements were written", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 4,
      resetAt: new Date(Date.now() + 1000),
    } as never);
    vi.mocked(prisma.measurement.create).mockRejectedValue(
      new Error("P2002 duplicate"),
    );

    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({
          measurements: [
            {
              type: "WEIGHT",
              value: 82.4,
              unit: "kg",
              measuredAt: "2026-05-14T07:00:00.000Z",
            },
          ],
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBeLessThan(400);
    // Every measurement raised a duplicate — no rollup fold needed.
    expect(recomputeBucketsForMeasurement).not.toHaveBeenCalled();
  });
});

// v1.17.1 — two real bugs the data-portability audit found in the JSON
// import. Regression guards so a future refactor can't silently re-open
// them.
describe("POST /api/import — entry-instant bound (v1.17.1)", () => {
  beforeEach(() => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 4,
      resetAt: new Date(Date.now() + 1000),
    } as never);
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);
  });

  it("rejects a future-dated measurement (previously accepted)", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({
          measurements: [
            { type: "WEIGHT", value: 80, unit: "kg", measuredAt: future },
          ],
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(422);
    expect(vi.mocked(prisma.measurement.create)).not.toHaveBeenCalled();
  });

  it("rejects a pre-1900 measurement", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({
          measurements: [
            {
              type: "WEIGHT",
              value: 80,
              unit: "kg",
              measuredAt: "1899-01-01T00:00:00.000Z",
            },
          ],
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(422);
  });

  it("accepts a backdated (past) measurement", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({
          measurements: [
            {
              type: "WEIGHT",
              value: 80,
              unit: "kg",
              measuredAt: "2020-01-01T08:00:00.000Z",
            },
          ],
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBeLessThan(400);
    expect(vi.mocked(prisma.measurement.create)).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/import — measurement externalId dedup (v1.17.1)", () => {
  beforeEach(() => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 4,
      resetAt: new Date(Date.now() + 1000),
    } as never);
  });

  it("upserts (not creates) when a measurement carries an externalId", async () => {
    vi.mocked(prisma.measurement.upsert).mockResolvedValue({} as never);

    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({
          measurements: [
            {
              type: "WEIGHT",
              value: 80,
              unit: "kg",
              measuredAt: "2026-05-01T08:00:00.000Z",
              externalId: "scale-row-42",
            },
          ],
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBeLessThan(400);
    expect(vi.mocked(prisma.measurement.upsert)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.measurement.create)).not.toHaveBeenCalled();
    const arg = vi.mocked(prisma.measurement.upsert).mock.calls[0][0];
    expect(arg.where).toEqual({
      userId_type_source_externalId: {
        userId: "u-1",
        type: "WEIGHT",
        source: "IMPORT",
        externalId: "scale-row-42",
      },
    });
  });

  it("still creates (first-write-wins) when no externalId is present", async () => {
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({
          measurements: [
            {
              type: "WEIGHT",
              value: 80,
              unit: "kg",
              measuredAt: "2026-05-01T08:00:00.000Z",
            },
          ],
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBeLessThan(400);
    expect(vi.mocked(prisma.measurement.create)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.measurement.upsert)).not.toHaveBeenCalled();
  });
});
