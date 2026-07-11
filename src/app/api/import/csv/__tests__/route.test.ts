import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({
    user: { id: "u-1" },
    session: { id: "s-1" },
  })),
}));

vi.mock("@/lib/db", () => {
  const measurement = {
    findMany: vi.fn(),
    createMany: vi.fn(),
    updateMany: vi.fn(),
  };
  return {
    prisma: {
      measurement,
      // Run the batched write callback against the same measurement mock so
      // createMany / updateMany calls are observable.
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
        fn({ measurement }),
      ),
    },
  };
});

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

// v1.23 — deterministic note-cipher so the route test stays isolated from the
// encryption-key env. `enc:<text>` stands in for the AES-256-GCM ciphertext.
vi.mock("@/lib/crypto/note-cipher", () => ({
  encryptNote: (s: string | null | undefined) =>
    s === null || s === undefined || s.length === 0
      ? null
      : new Uint8Array(Buffer.from(`enc:${s}`, "utf8")),
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
  // Default: nothing pre-exists; the transaction runner is re-stubbed by the
  // db mock factory (resetAllMocks clears its implementation), so restore it.
  const measurement = prisma.measurement as unknown as {
    findMany: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  measurement.findMany.mockResolvedValue([]);
  // Echo the attempted chunk size, matching Postgres semantics when no row
  // collides — the route now reconciles `inserted` against this count.
  measurement.createMany.mockImplementation(
    async (arg: { data: unknown[] }) => ({ count: arg.data.length }),
  );
  measurement.updateMany.mockResolvedValue({ count: 0 });
  (
    prisma.$transaction as unknown as {
      mockImplementation: (f: unknown) => void;
    }
  ).mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ measurement }),
  );
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

const mMeasurement = () =>
  prisma.measurement as unknown as {
    findMany: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };

describe("POST /api/import/csv — fatal header error", () => {
  it("returns 422 when a required column is missing", async () => {
    const res = await POST(csvRequest("type,value,unit\nWEIGHT,80,kg"));
    expect(res.status).toBe(422);
    expect(mMeasurement().createMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/import/csv — batched write + per-row envelope", () => {
  it("inserts valid rows, skips invalid ones, returns per-row status", async () => {
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
    // One bulk createMany carrying the single valid survivor.
    expect(mMeasurement().createMany).toHaveBeenCalledTimes(1);
    const arg = mMeasurement().createMany.mock.calls[0][0];
    expect(arg.data).toHaveLength(1);
    // Rollup re-fold fired for the touched (type, day).
    expect(vi.mocked(recomputeBucketsForMeasurement)).toHaveBeenCalled();
  });

  it("batches many rows into a single createMany (no per-row round-trip)", async () => {
    const rows = [HEADER];
    for (let i = 0; i < 50; i++) {
      const mm = String(i).padStart(2, "0"); // unique minute → unique measuredAt
      rows.push(`WEIGHT,${80 + i * 0.1},kg,2026-05-01T08:${mm}:00Z,,,`);
    }
    const res = await POST(csvRequest(rows.join("\n")));
    expect(res.status).toBe(200);
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.inserted).toBe(50);
    // 50 rows, one createMany call — the whole point of the batch.
    expect(mMeasurement().createMany).toHaveBeenCalledTimes(1);
    expect(mMeasurement().createMany.mock.calls[0][0].data).toHaveLength(50);
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
    expect(mMeasurement().createMany).not.toHaveBeenCalled();
    expect(vi.mocked(recomputeBucketsForMeasurement)).not.toHaveBeenCalled();
  });

  it("surfaces an externalId row as updated when it already existed (updateMany)", async () => {
    mMeasurement().findMany.mockResolvedValue([
      { type: "WEIGHT", externalId: "ext-1" },
    ]);

    const res = await POST(
      csvRequest(
        [HEADER, "WEIGHT,80.5,kg,2026-05-01T08:00:00Z,,,ext-1"].join("\n"),
      ),
    );
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.updated).toBe(1);
    expect(body.data?.inserted).toBe(0);
    expect(body.data?.rows[0].status).toBe("updated");
    expect(mMeasurement().updateMany).toHaveBeenCalledTimes(1);
    expect(mMeasurement().createMany).not.toHaveBeenCalled();
  });

  it("resurrects a tombstoned externalId row on re-import (deletedAt: null in update)", async () => {
    // The ext-probe is deliberately deletedAt-less, so a tombstoned IMPORT
    // row matches like a live one; the update must carry the resurrection
    // (IMPORT rows are re-importable by design).
    mMeasurement().findMany.mockResolvedValue([
      { type: "WEIGHT", externalId: "ext-tomb" },
    ]);

    const res = await POST(
      csvRequest(
        [HEADER, "WEIGHT,81.0,kg,2026-05-01T08:00:00Z,,,ext-tomb"].join("\n"),
      ),
    );
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.updated).toBe(1);
    expect(body.data?.rows[0].status).toBe("updated");
    const updateArg = mMeasurement().updateMany.mock.calls[0][0] as {
      data: { value: number; deletedAt: Date | null };
    };
    expect(updateArg.data.value).toBe(81.0);
    expect(updateArg.data.deletedAt).toBeNull();
  });

  it("inserts an externalId row when it does not exist yet", async () => {
    mMeasurement().findMany.mockResolvedValue([]);
    const res = await POST(
      csvRequest(
        [HEADER, "WEIGHT,80.5,kg,2026-05-01T08:00:00Z,,,ext-2"].join("\n"),
      ),
    );
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.inserted).toBe(1);
    expect(body.data?.updated).toBe(0);
    expect(body.data?.rows[0].status).toBe("inserted");
    expect(mMeasurement().createMany).toHaveBeenCalledTimes(1);
  });

  it("counts a pre-existing natural-key row as skipped/duplicate", async () => {
    mMeasurement().findMany.mockResolvedValue([
      { type: "WEIGHT", measuredAt: new Date("2026-05-01T08:00:00Z") },
    ]);

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
    expect(mMeasurement().createMany).not.toHaveBeenCalled();
  });

  it("collapses an in-file duplicate (same type+measuredAt) to one insert + one duplicate", async () => {
    const res = await POST(
      csvRequest(
        [
          HEADER,
          "WEIGHT,80.5,kg,2026-05-01T08:00:00Z,,,",
          "WEIGHT,80.6,kg,2026-05-01T08:00:00Z,,,",
        ].join("\n"),
      ),
    );
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.inserted).toBe(1);
    expect(body.data?.skipped).toBe(1);
    // Only the first survivor reaches the bulk insert.
    expect(mMeasurement().createMany.mock.calls[0][0].data).toHaveLength(1);
  });

  it("reconciles `inserted` against the createMany count when skipDuplicates absorbs a race", async () => {
    // Two fresh rows attempted, but a concurrent double-submit already
    // landed one of them — `skipDuplicates` absorbs the conflict and the
    // count comes back short. The envelope must sum to the DB truth: one
    // inserted, one downgraded to skipped/duplicate.
    mMeasurement().createMany.mockImplementation(
      async (arg: { data: unknown[] }) => ({ count: arg.data.length - 1 }),
    );

    const res = await POST(
      csvRequest(
        [
          HEADER,
          "WEIGHT,80.5,kg,2026-05-01T08:00:00Z,,,",
          "WEIGHT,81.5,kg,2026-05-01T09:00:00Z,,,",
        ].join("\n"),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as CsvEnvelope;
    expect(body.data?.inserted).toBe(1);
    expect(body.data?.skipped).toBe(1);
    const statuses = body.data?.rows.map((r) => r.status).sort();
    expect(statuses).toEqual(["inserted", "skipped"]);
    expect(body.data?.rows.find((r) => r.status === "skipped")?.reason).toBe(
      "duplicate",
    );
  });
});
