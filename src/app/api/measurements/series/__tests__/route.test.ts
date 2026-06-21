import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

// v1.11.4 — the sleep branch resolves the user's tz to bucket per-night;
// pin it so the night grouping is deterministic.
vi.mock("@/lib/tz/resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tz/resolver")>();
  return { ...actual, resolveUserTimezone: vi.fn(async () => "UTC") };
});

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

// v1.11.4 — the sleep branch loads the user's source-priority ladder to
// collapse a dual-source night; pin it to the defaults so the test stays
// hermetic (no DB user read).
vi.mock("@/lib/rollups/measurement-read", () => ({
  loadUserSourcePriority: vi.fn(async () => null),
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging/context")>();
  return {
    ...actual,
    annotate: vi.fn(),
  };
});

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { annotate } from "@/lib/logging/context";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

function req(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/measurements/series?${query}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    glucoseUnit: "mg/dL",
  } as never);
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

  it("surfaces per-point min/max for kind=pulse (iOS #34 ext)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      // hourly HR bucket — average + spread
      {
        id: "p1",
        value: 72,
        measuredAt: new Date("2026-06-21T14:00:00.000Z"),
        valueMin: 58,
        valueMax: 96,
      },
      // per-sample PULSE row — no spread
      {
        id: "p2",
        value: 64,
        measuredAt: new Date("2026-06-21T15:00:00.000Z"),
        valueMin: null,
        valueMax: null,
      },
    ] as never);
    const res = await GET(req("kind=pulse&days=7"));
    const body = (await res.json()) as {
      data: {
        points: Array<{
          value: number;
          valueMin: number | null;
          valueMax: number | null;
        }>;
      };
    };
    expect(body.data.points[0].valueMin).toBe(58);
    expect(body.data.points[0].valueMax).toBe(96);
    expect(body.data.points[1].valueMin).toBeNull();
    expect(body.data.points[1].valueMax).toBeNull();

    // The pulse read selects the spread columns.
    const selectArg = vi.mocked(prisma.measurement.findMany).mock.calls[0][0];
    expect(
      (selectArg as { select: Record<string, boolean> }).select.valueMin,
    ).toBe(true);
    expect(
      (selectArg as { select: Record<string, boolean> }).select.valueMax,
    ).toBe(true);
  });

  it("collapses sleep stage rows into one night point in hours (v1.11.4)", async () => {
    // SLEEP_DURATION is stored one row per STAGE per night (minutes). The
    // series must return ONE point per night carrying the TIME-ASLEEP
    // total in hours, not a point per stage.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      {
        id: "s1",
        value: 240,
        measuredAt: new Date("2026-06-04T00:00:00.000Z"),
        sleepStage: "CORE",
      },
      {
        id: "s2",
        value: 90,
        measuredAt: new Date("2026-06-04T02:00:00.000Z"),
        sleepStage: "DEEP",
      },
      {
        id: "s3",
        value: 80,
        measuredAt: new Date("2026-06-04T04:00:00.000Z"),
        sleepStage: "REM",
      },
      {
        id: "s4",
        value: 60,
        measuredAt: new Date("2026-06-04T05:00:00.000Z"),
        sleepStage: "AWAKE",
      },
      {
        id: "s5",
        value: 480,
        measuredAt: new Date("2026-06-03T23:00:00.000Z"),
        sleepStage: "IN_BED",
      },
    ] as never);
    const res = await GET(req("kind=sleep&days=30"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        unit: string;
        points: Array<{
          value: number;
          sleepStages: Record<string, number> | null;
        }>;
      };
    };
    expect(body.data.unit).toBe("h");
    // One point for the single night.
    expect(body.data.points).toHaveLength(1);
    // Time asleep = CORE + DEEP + REM = 410 min → 6.83 h (IN_BED + AWAKE
    // excluded).
    expect(body.data.points[0].value).toBeCloseTo(410 / 60, 2);
    expect(body.data.points[0].sleepStages?.CORE).toBeCloseTo(4, 2);
  });

  it("returns an explicit unit for a non-sleep kind (v1.11.4)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { id: "w1", value: 78.4, measuredAt: new Date() },
    ] as never);
    const res = await GET(req("kind=weight&days=7"));
    const body = (await res.json()) as { data: { unit: string } };
    expect(body.data.unit).toBe("kg");
  });

  it("returns glucose in mg/dL with raw values for a mg/dL-preference user (v1.16.16)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      glucoseUnit: "mg/dL",
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { id: "g1", value: 100, measuredAt: new Date("2026-06-01T08:00:00Z") },
      { id: "g2", value: 126, measuredAt: new Date("2026-06-02T08:00:00Z") },
    ] as never);
    const res = await GET(req("kind=glucose&days=30"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { unit: string; points: Array<{ value: number }> };
    };
    expect(body.data.unit).toBe("mg/dL");
    expect(body.data.points.map((p) => p.value)).toEqual([100, 126]);
  });

  it("converts glucose to mmol/L (value + unit) for a mmol/L-preference user (v1.16.16)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      glucoseUnit: "mmol/L",
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { id: "g1", value: 100, measuredAt: new Date("2026-06-01T08:00:00Z") },
      { id: "g2", value: 126, measuredAt: new Date("2026-06-02T08:00:00Z") },
    ] as never);
    const res = await GET(req("kind=glucose&days=30"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        unit: string;
        points: Array<{ value: number }>;
        stats: { min: number; max: number };
      };
    };
    expect(body.data.unit).toBe("mmol/L");
    // 100 mg/dL → 5.5 mmol/L, 126 mg/dL → 7.0 mmol/L (1-decimal).
    expect(body.data.points[0].value).toBe(5.5);
    expect(body.data.points[1].value).toBe(7);
    // Stats are derived from the converted points → also in mmol/L.
    expect(body.data.stats.min).toBe(5.5);
    expect(body.data.stats.max).toBe(7);
  });

  it("computes mmol/L stats over raw mg/dL then converts once (v1.16.16 parity)", async () => {
    // Parity with the detail page + FHIR convention: aggregate the raw mg/dL
    // values, then convert each stat figure ONCE. Deriving the mean from the
    // already-converted points (5.5, 7.0 → 6.25) double-rounds; the raw path
    // (mean 113 mg/dL → 6.3 mmol/L) matches the detail page.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      glucoseUnit: "mmol/L",
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { id: "g1", value: 100, measuredAt: new Date("2026-06-01T08:00:00Z") },
      { id: "g2", value: 126, measuredAt: new Date("2026-06-02T08:00:00Z") },
    ] as never);
    const res = await GET(req("kind=glucose&days=30"));
    const body = (await res.json()) as {
      data: { stats: { mean: number } };
    };
    // mean(100,126) = 113 mg/dL → 6.3 mmol/L (NOT mean(5.5,7.0) = 6.25).
    expect(body.data.stats.mean).toBe(6.3);
  });

  it("keeps a single mmol/L reading's stats identical to its point (v1.16.16)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      glucoseUnit: "mmol/L",
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { id: "g1", value: 100, measuredAt: new Date("2026-06-01T08:00:00Z") },
    ] as never);
    const res = await GET(req("kind=glucose&days=30"));
    const body = (await res.json()) as {
      data: { points: Array<{ value: number }>; stats: { mean: number } };
    };
    expect(body.data.points[0].value).toBe(5.5);
    expect(body.data.stats.mean).toBe(5.5);
  });

  it("defaults glucose to mg/dL when the user has no preference (v1.16.16)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      glucoseUnit: null,
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      { id: "g1", value: 100, measuredAt: new Date("2026-06-01T08:00:00Z") },
    ] as never);
    const res = await GET(req("kind=glucose&days=30"));
    const body = (await res.json()) as {
      data: { unit: string; points: Array<{ value: number }> };
    };
    expect(body.data.unit).toBe("mg/dL");
    expect(body.data.points[0].value).toBe(100);
  });

  it("accepts the ten-year window (days=3650 — iOS 'Alle'-range)", async () => {
    // v1.5.5 — the previous 365-day cap rejected the iOS app's
    // "Alle"-range request with a 422, painting an error banner on
    // every metric tile. Ten years matches the recurrence engine's
    // hard cap and the medication course-window upper bound.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    const res = await GET(req("kind=weight&days=3650"));
    expect(res.status).toBe(200);
  });

  it("rejects a days value above the ten-year cap", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(req("kind=weight&days=3651"));
    expect(res.status).toBe(422);
  });

  it.each(["restingHeartRate", "heartRateVariability", "vo2Max"])(
    "accepts kind=%s (v1.5.5)",
    async (kind) => {
      // v1.5.5 — the iOS app surfaces these as series-capable; the
      // previous enum rejected them with 422 even though the
      // underlying MeasurementType already carried the values.
      vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
      vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
      const res = await GET(req(`kind=${kind}&days=30`));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { kind: string } };
      expect(body.data.kind).toBe(kind);
    },
  );
});

describe("GET /api/measurements/series — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // bad `kind` (invalid enum) + `days=0` (below min 1).
    const res = await GET(req("kind=garbage&days=0"));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      data: null;
      error: string;
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
    };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("surfaces multiple simultaneous validation errors (≥2)", async () => {
    // The series schema has only two knobs (kind + days), so a strict
    // 3-issue case is not natural. We pin the multi-issue contract on
    // ≥ 2 here — the helper's 3-issue path is exhaustively covered by
    // `src/lib/__tests__/api-response-zod.test.ts` and the routes with
    // wider schemas (measurements, devices, mood-entries).
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(req("kind=junk&days=-999"));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string }> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("writes a measurements.series.validation-failed audit row", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(req("kind=garbage&days=0"));
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { userId: string; action: string };
    };
    expect(call.data.userId).toBe("user-1");
    expect(call.data.action).toBe("measurements.series.validation-failed");
  });

  it("surfaces received_keys + received_shape_excerpt + zod_issues in the wide-event meta (v1.4.48 H-iOS-2)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(req("kind=garbage&days=0&extraGarbage=fromIos"));
    expect(res.status).toBe(422);

    const annotated = vi
      .mocked(annotate)
      .mock.calls.find(
        (call) =>
          (call[0] as { action?: { name?: string } })?.action?.name ===
          "measurements.series.validation-failed",
      );
    expect(annotated, "validation-failed annotate call").toBeTruthy();
    const meta = (annotated![0] as { meta?: Record<string, unknown> }).meta!;

    expect(meta.received_keys).toEqual(
      expect.arrayContaining(["kind", "days", "extraGarbage"]),
    );
    expect(typeof meta.received_shape_excerpt).toBe("string");
    expect((meta.received_shape_excerpt as string).length).toBeLessThanOrEqual(
      256,
    );
    expect(meta.received_shape_excerpt as string).toContain('"kind":"garbage"');

    const issues = meta.zod_issues as Array<{ path: string; code: string }>;
    expect(Array.isArray(issues)).toBe(true);
    expect(issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("caps received_shape_excerpt at 256 chars even for a long iOS query", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const long = "x".repeat(500);
    const res = await GET(req(`kind=garbage&days=0&junk=${long}`));
    expect(res.status).toBe(422);
    const annotated = vi
      .mocked(annotate)
      .mock.calls.find(
        (call) =>
          (call[0] as { action?: { name?: string } })?.action?.name ===
          "measurements.series.validation-failed",
      );
    const meta = (annotated![0] as { meta?: Record<string, unknown> }).meta!;
    expect((meta.received_shape_excerpt as string).length).toBe(256);
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(
      new Error("db down"),
    );
    const res = await GET(req("kind=garbage&days=0"));
    expect(res.status).toBe(422);
  });

  it("redacts sensitive query keys before writing the wide-event received_shape_excerpt (v1.4.49)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // An attacker-shaped query that mixes a valid `kind` with a
    // credential-shaped `token` param. The excerpt must keep `kind`
    // readable for operator debug but redact the token verbatim.
    const res = await GET(
      req("kind=garbage&days=0&token=hlk_secret_value&apiKey=sk_live_xxx"),
    );
    expect(res.status).toBe(422);

    const annotated = vi
      .mocked(annotate)
      .mock.calls.find(
        (call) =>
          (call[0] as { action?: { name?: string } })?.action?.name ===
          "measurements.series.validation-failed",
      );
    const meta = (annotated![0] as { meta?: Record<string, unknown> }).meta!;
    const excerpt = meta.received_shape_excerpt as string;

    expect(excerpt).not.toContain("hlk_secret_value");
    expect(excerpt).not.toContain("sk_live_xxx");
    expect(excerpt).toContain("[redacted]");
    // The key inventory still surfaces so operators see the shape.
    expect(meta.received_keys).toEqual(
      expect.arrayContaining(["kind", "days", "token", "apiKey"]),
    );
  });

  it("strips `message` from the audit-ledger issues row (v1.4.49)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    await GET(req("kind=garbage&days=0"));

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { details: string };
    };
    const parsed = JSON.parse(call.data.details) as {
      issues: Array<Record<string, unknown>>;
    };
    for (const issue of parsed.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
    }
  });
});
