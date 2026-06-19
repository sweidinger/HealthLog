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

vi.mock("@/lib/rollups/measurement-rollups", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/rollups/measurement-rollups")
  >("@/lib/rollups/measurement-rollups");
  return {
    ...actual,
    recomputeBucketsForMeasurement: vi.fn().mockResolvedValue(undefined),
  };
});

import { NextRequest } from "next/server";
import { POST } from "../route";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { recomputeBucketsForMeasurement } from "@/lib/rollups/measurement-rollups";

const HEADER = "type,value,unit,measuredAt,glucoseContext,notes,externalId";

function csvRequest(csv: string, dryRun = false) {
  return new NextRequest(
    `http://localhost/api/import/csv${dryRun ? "?dryRun=1" : ""}`,
    {
      method: "POST",
      body: csv,
      headers: { "content-type": "text/csv" },
    },
  );
}

interface CsvEnvelope {
  data: {
    inserted: number;
    updated: number;
    skipped: number;
    total: number;
    dryRun: boolean;
    rows: Array<{ line: number; status: string; reason?: string }>;
  } | null;
  error: string | null;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 4,
    resetAt: new Date(Date.now() + 1000),
  } as never);
});

describe("POST /api/import/csv — rate limit", () => {
  it("returns 429 against the shared import bucket when exhausted", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 1000),
    } as never);

    const res = await POST(csvRequest([HEADER, ""].join("\n")));
    expect(res.status).toBe(429);
    expect(checkRateLimit).toHaveBeenCalledWith(
      expect.stringContaining("import:u-1"),
      5,
      60 * 60 * 1000,
    );
  });
});

describe("POST /api/import/csv — fatal header error", () => {
  it("returns 422 when a required column is missing", async () => {
    const res = await POST(csvRequest("type,value,unit\nWEIGHT,80,kg"));
    expect(res.status).toBe(422);
    expect(vi.mocked(prisma.measurement.create)).not.toHaveBeenCalled();
  });
});

describe("POST /api/import/csv — write loop + per-row envelope", () => {
  it("inserts valid rows, skips invalid ones, returns per-row status", async () => {
    vi.mocked(prisma.measurement.create).mockResolvedValue({} as never);

    const res = await POST(
      csvRequest(
        [
          HEADER,
          "WEIGHT,80.5,kg,2026-05-01T08:00:00Z,,morning,", // inserted
          "NOPE,1,kg,2026-05-01T08:00:00Z,,,", // skipped unknown_type
          "WEIGHT,80,kg,2026-05-01T08:00:00,,,", // skipped missing offset
        ].join("\n"),
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.inserted).toBe(1);
    expect(body.data?.skipped).toBe(2);
    expect(body.data?.total).toBe(3);
    expect(body.data?.dryRun).toBe(false);
    const reasons = body.data?.rows.map((r) => r.reason);
    expect(reasons).toContain("unknown_type");
    expect(reasons).toContain("missing_timezone_offset");
    // One create call for the single valid row.
    expect(vi.mocked(prisma.measurement.create)).toHaveBeenCalledTimes(1);
    // Rollup re-fold fired for the touched (type, day).
    expect(vi.mocked(recomputeBucketsForMeasurement)).toHaveBeenCalled();
  });

  it("dryRun previews without writing and reports projected inserts", async () => {
    const res = await POST(
      csvRequest(
        [HEADER, "WEIGHT,80.5,kg,2026-05-01T08:00:00Z,,,"].join("\n"),
        true,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.dryRun).toBe(true);
    expect(body.data?.inserted).toBe(1);
    expect(body.data?.rows[0].status).toBe("inserted");
    expect(vi.mocked(prisma.measurement.create)).not.toHaveBeenCalled();
    expect(vi.mocked(recomputeBucketsForMeasurement)).not.toHaveBeenCalled();
  });

  it("upserts an externalId row and surfaces it as updated when it already existed", async () => {
    const created = new Date("2026-05-01T08:00:00Z");
    const bumped = new Date("2026-05-02T08:00:00Z");
    vi.mocked(prisma.measurement.upsert).mockResolvedValue({
      createdAt: created,
      updatedAt: bumped,
    } as never);

    const res = await POST(
      csvRequest(
        [HEADER, "WEIGHT,80.5,kg,2026-05-01T08:00:00Z,,,ext-1"].join("\n"),
      ),
    );
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.updated).toBe(1);
    expect(body.data?.inserted).toBe(0);
    expect(body.data?.rows[0].status).toBe("updated");
    expect(vi.mocked(prisma.measurement.upsert)).toHaveBeenCalledTimes(1);
  });

  it("counts a unique-constraint duplicate as skipped/duplicate", async () => {
    vi.mocked(prisma.measurement.create).mockRejectedValue(
      new Error("Unique constraint failed"),
    );

    const res = await POST(
      csvRequest([HEADER, "WEIGHT,80.5,kg,2026-05-01T08:00:00Z,,,"].join("\n")),
    );
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.inserted).toBe(0);
    expect(body.data?.skipped).toBe(1);
    expect(body.data?.rows[0]).toMatchObject({
      status: "skipped",
      reason: "duplicate",
    });
  });
});
