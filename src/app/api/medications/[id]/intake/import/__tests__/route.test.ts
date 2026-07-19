/**
 * v1.4.43 W6 — multi-issue 422 envelope on POST
 * /api/medications/[id]/intake/import. Preserves the
 * `medication.intake.import.invalid_format` errorCode meta so the CSV
 * import client UI can branch on the prefix semantics.
 *
 * v1.29 perf fix — the per-row `findUnique` duplicate probe was replaced by
 * one indexed `findMany` existence read over every row's idempotencyKey
 * before the write loop. `create` + `consumeForIntake` stay per-row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: {
      findUnique: vi.fn(),
    },
    medicationIntakeEvent: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMedications: vi.fn(),
}));
vi.mock("@/lib/medications/inventory/consumption", () => ({
  consumeForIntake: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rollups/medication-compliance-rollups", () => ({
  recomputeMedicationComplianceForDay: vi.fn().mockResolvedValue(undefined),
  dayKeyForScheduledFor: vi.fn().mockReturnValue("2026-01-01"),
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

// (#22) — silent cross-device intake sync. Mocked so the route test can
// assert the hook without reaching the APNs senders or the coalescing
// timers.
vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

import { POST } from "../route";
import { queueMedicationIntakeSync } from "@/lib/notifications/medication-intake-sync";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { consumeForIntake } from "@/lib/medications/inventory/consumption";
import { checkRateLimit } from "@/lib/rate-limit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/medications/m1/intake/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ROUTE_CTX = { params: Promise.resolve({ id: "m1" }) };

/** Mirrors the route's own dedup-key derivation for a zaehler-less row. */
function keyFor(medId: string, datum: string, uhrzeit: string): string {
  const takenAt = new Date(`${datum}T${uhrzeit}`);
  return `import-${medId}-${takenAt.getTime()}`;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 60,
    resetAt: Date.now() + 60_000,
  });
  vi.mocked(prisma.medication.findUnique).mockResolvedValue({
    id: "m1",
    userId: "user-1",
  } as never);
});

describe("POST /api/medications/[id]/intake/import — 422 multi-issue (v1.4.43 W6)", () => {
  it("rejects a body over the 1 MB cap with 413 before parsing", async () => {
    const res = await POST(postReq(["x".repeat(1024 * 1024)]), ROUTE_CTX);
    expect(res.status).toBe(413);
  });

  it("surfaces TWO simultaneous validation errors", async () => {
    // Two entries with malformed datum + malformed uhrzeit.
    const res = await POST(
      postReq([
        { datum: "not-a-date", uhrzeit: "07:00:00" },
        { datum: "2026-01-01", uhrzeit: "not-a-time" },
      ]),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      data: null;
      error: string;
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
      meta?: { errorCode?: string };
    };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
    // Special: the CSV-import UI branches on this errorCode to preserve
    // the historical "Invalid format: …" client behaviour.
    expect(body.meta?.errorCode).toBe(
      "medication.intake.import.invalid_format",
    );
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("surfaces THREE simultaneous validation errors", async () => {
    const res = await POST(
      postReq([
        { datum: "not-a-date", uhrzeit: "not-a-time" },
        { datum: "also-bad", uhrzeit: "07:00:00" },
        { datum: "2026-01-01", uhrzeit: "weird" },
      ]),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
      meta?: { errorCode?: string };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
    expect(body.meta?.errorCode).toBe(
      "medication.intake.import.invalid_format",
    );
  });

  it("writes the audit-ledger row keyed medications.intake.import.validation-failed", async () => {
    const res = await POST(
      postReq([{ datum: "not-a-date", uhrzeit: "07:00:00" }]),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { userId: string; action: string };
    };
    expect(call.data.action).toBe(
      "medications.intake.import.validation-failed",
    );
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(
      new Error("db down"),
    );
    const res = await POST(
      postReq([{ datum: "not-a-date", uhrzeit: "07:00:00" }]),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
  });
});

describe("POST /api/medications/[id]/intake/import — inventory consumption", () => {
  beforeEach(() => {
    // Fresh imports: the batched existence read finds no prior rows, and
    // create echoes an id.
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([]);
    let n = 0;
    vi.mocked(prisma.medicationIntakeEvent.create).mockImplementation(
      (async () => ({ id: `evt-${++n}`, takenAt: new Date() })) as never,
    );
  });

  it("consumes stock once per freshly imported taken dose", async () => {
    const res = await POST(
      postReq([
        { datum: "2026-01-01", uhrzeit: "07:00:00" },
        { datum: "2026-01-01", uhrzeit: "19:00:00" },
        { datum: "2026-01-02", uhrzeit: "07:00:00" },
      ]),
      ROUTE_CTX,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { imported: number } };
    expect(body.data.imported).toBe(3);
    expect(consumeForIntake).toHaveBeenCalledTimes(3);
    const call = vi.mocked(consumeForIntake).mock.calls[0]?.[0];
    expect(call?.medicationId).toBe("m1");
    expect(call?.userId).toBe("user-1");
    expect(call?.eventId).toBe("evt-1");

    // The three-row import reads existence in ONE indexed query, not one
    // findUnique probe per row.
    expect(prisma.medicationIntakeEvent.findMany).toHaveBeenCalledTimes(1);
    const findManyArg = vi.mocked(prisma.medicationIntakeEvent.findMany).mock
      .calls[0]?.[0] as { where: { idempotencyKey: { in: string[] } } };
    expect(findManyArg.where.idempotencyKey.in).toHaveLength(3);

    // (#22) — the whole import queues exactly ONE cross-device sync
    // fan-out, not one per imported row.
    expect(queueMedicationIntakeSync).toHaveBeenCalledTimes(1);
  });

  it("does not consume for duplicate (already-imported) rows", async () => {
    // First entry's key is already present — the batched existence read
    // reports it, the second entry's key is absent (fresh).
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
      { idempotencyKey: keyFor("m1", "2026-01-01", "07:00:00") },
    ] as never);
    const res = await POST(
      postReq([
        { datum: "2026-01-01", uhrzeit: "07:00:00" },
        { datum: "2026-01-01", uhrzeit: "19:00:00" },
      ]),
      ROUTE_CTX,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { imported: number; skippedDuplicates: number };
    };
    expect(body.data.imported).toBe(1);
    expect(body.data.skippedDuplicates).toBe(1);
    // Only the fresh row consumes — the duplicate never re-creates an event,
    // so re-import cannot double-decrement.
    expect(consumeForIntake).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/medications/[id]/intake/import — bounds and limiter", () => {
  beforeEach(() => {
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([]);
    vi.mocked(prisma.medicationIntakeEvent.create).mockImplementation(
      (async (args: { data: { takenAt: Date } }) => ({
        id: "evt-1",
        takenAt: args.data.takenAt,
      })) as never,
    );
  });

  // The `\d{4}-\d{2}-\d{2}` regex has no upper bound. A future-dated row used
  // to create a "taken" intake ahead of now, which then fed compliance and the
  // dose-history ledger. The single and bulk intake twins bound this through
  // `boundedTakenAtSchema`.
  it("skips a future-dated row instead of importing it", async () => {
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    const datum = future.toISOString().slice(0, 10);
    const res = await POST(
      postReq([{ datum, uhrzeit: "07:00:00" }]),
      ROUTE_CTX,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { imported: number; skippedInvalid: number };
    };
    expect(body.data.imported).toBe(0);
    expect(body.data.skippedInvalid).toBe(1);
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
  });

  it("still imports a historical row — the past side stays unbounded", async () => {
    const res = await POST(
      postReq([{ datum: "2019-03-04", uhrzeit: "07:00:00" }]),
      ROUTE_CTX,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { imported: number } };
    expect(body.data.imported).toBe(1);
  });

  // This was the one intake write path with no limiter, while running up to
  // 1000 sequential find + create + inventory-consume iterations per call.
  it("refuses with 429 once the import limiter trips", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await POST(
      postReq([{ datum: "2026-01-01", uhrzeit: "07:00:00" }]),
      ROUTE_CTX,
    );
    expect(res.status).toBe(429);
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
  });

  it("buckets the limiter per user", async () => {
    await POST(
      postReq([{ datum: "2026-01-01", uhrzeit: "07:00:00" }]),
      ROUTE_CTX,
    );
    expect(checkRateLimit).toHaveBeenCalledWith(
      "medications:intake:import:user-1",
      expect.any(Number),
      expect.any(Number),
    );
  });
});
