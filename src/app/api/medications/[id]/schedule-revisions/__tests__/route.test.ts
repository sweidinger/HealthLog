/**
 * v1.16.5 — schedule-era endpoints: ownership, validation, provenance.
 *
 *   GET    /api/medications/[id]/schedule-revisions
 *   POST   /api/medications/[id]/schedule-revisions
 *   DELETE /api/medications/[id]/schedule-revisions/[revisionId]
 *
 * The POST guards are the contract under test: a manual era must end
 * at or before the start of the live plan, must not overlap an
 * archived era, and is always minted with `source: "MANUAL"`. The
 * DELETE refuses write-path archives (409) so the immutable history
 * the replace path mints can never be falsified through the API.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: {
      findUnique: vi.fn(),
    },
    medicationScheduleRevision: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rollups/medication-compliance-rollups", () => ({
  enqueueUserMedicationComplianceBackfill: vi
    .fn()
    .mockResolvedValue({ enqueued: true, error: null }),
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

import { GET, POST } from "../route";
import { DELETE } from "../[revisionId]/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { enqueueUserMedicationComplianceBackfill } from "@/lib/rollups/medication-compliance-rollups";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

const ROUTE_CTX = { params: Promise.resolve({ id: "m1" }) };

function getReq(): NextRequest {
  return new NextRequest(
    "http://localhost/api/medications/m1/schedule-revisions",
  );
}

function postReq(body: unknown): NextRequest {
  return new NextRequest(
    "http://localhost/api/medications/m1/schedule-revisions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function deleteReq(revisionId: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/medications/m1/schedule-revisions/${revisionId}`,
    { method: "DELETE" },
  );
}

function deleteCtx(revisionId: string) {
  return { params: Promise.resolve({ id: "m1", revisionId }) };
}

const MED_CREATED_AT = new Date("2026-01-10T08:00:00Z");

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  // Ownership guard + GET both read `medication.findUnique`; the guard
  // selects `{ id, userId }`, the GET selects `{ createdAt }` — one
  // superset row satisfies both.
  vi.mocked(prisma.medication.findUnique).mockResolvedValue({
    id: "m1",
    userId: "user-1",
    createdAt: MED_CREATED_AT,
  } as never);
  vi.mocked(prisma.medicationScheduleRevision.findMany).mockResolvedValue(
    [] as never,
  );
});

describe("GET /api/medications/[id]/schedule-revisions", () => {
  it("404s for another user's medication (existence sealed)", async () => {
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      id: "m1",
      userId: "someone-else",
      createdAt: MED_CREATED_AT,
    } as never);
    const res = await GET(getReq(), ROUTE_CTX);
    expect(res.status).toBe(404);
  });

  it("returns currentSince = createdAt when no revision exists", async () => {
    const res = await GET(getReq(), ROUTE_CTX);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.currentSince).toBe(MED_CREATED_AT.toISOString());
    expect(json.data.revisions).toEqual([]);
  });

  it("returns currentSince = newest validUntil and summarised entries", async () => {
    vi.mocked(prisma.medicationScheduleRevision.findMany).mockResolvedValue([
      {
        id: "rev-2",
        validFrom: new Date("2026-03-01T00:00:00Z"),
        validUntil: new Date("2026-05-01T00:00:00Z"),
        source: "ARCHIVED",
        payload: [
          {
            timesOfDay: ["07:00", "19:00"],
            label: "Morgens",
            dose: null,
            scheduleType: "SCHEDULED",
          },
        ],
      },
      {
        id: "rev-1",
        validFrom: new Date("2026-01-10T08:00:00Z"),
        validUntil: new Date("2026-03-01T00:00:00Z"),
        source: "MANUAL",
        // Malformed payload must degrade, never throw on a read path.
        payload: { not: "an array" },
      },
    ] as never);

    const res = await GET(getReq(), ROUTE_CTX);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.currentSince).toBe("2026-05-01T00:00:00.000Z");
    expect(json.data.revisions).toHaveLength(2);
    expect(json.data.revisions[0].entries[0].timesOfDay).toEqual([
      "07:00",
      "19:00",
    ]);
    expect(json.data.revisions[1].entries).toEqual([]);
    expect(json.data.revisions[1].source).toBe("MANUAL");
  });
});

describe("POST /api/medications/[id]/schedule-revisions", () => {
  const VALID_BODY = {
    validFrom: "2025-03-12T00:00:00.000Z",
    validUntil: "2025-06-01T00:00:00.000Z",
    timesOfDay: ["19:00", "07:00"],
  };

  it("404s for another user's medication", async () => {
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      id: "m1",
      userId: "someone-else",
      createdAt: MED_CREATED_AT,
    } as never);
    const res = await POST(postReq(VALID_BODY), ROUTE_CTX);
    expect(res.status).toBe(404);
    expect(prisma.medicationScheduleRevision.create).not.toHaveBeenCalled();
  });

  it("422s when validFrom is not before validUntil", async () => {
    const res = await POST(
      postReq({ ...VALID_BODY, validUntil: VALID_BODY.validFrom }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
  });

  it("422s on a malformed time literal", async () => {
    const res = await POST(
      postReq({ ...VALID_BODY, timesOfDay: ["25:99"] }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
  });

  it("422s when the era overlaps an archived era", async () => {
    vi.mocked(prisma.medicationScheduleRevision.findMany).mockResolvedValue([
      {
        validFrom: new Date("2025-05-01T00:00:00Z"),
        validUntil: new Date("2026-01-01T00:00:00Z"),
      },
    ] as never);
    const res = await POST(postReq(VALID_BODY), ROUTE_CTX);
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toMatch(/overlap/i);
  });

  it("422s when the era ends after the live plan began", async () => {
    vi.mocked(prisma.medicationScheduleRevision.findMany).mockResolvedValue([
      {
        validFrom: new Date("2025-01-01T00:00:00Z"),
        validUntil: new Date("2025-04-01T00:00:00Z"),
      },
    ] as never);
    // Ends 2025-06-01 — after the live plan start (2025-04-01) — and
    // does NOT overlap the archived era; the boundary check must fire.
    const res = await POST(
      postReq({ ...VALID_BODY, validFrom: "2025-04-01T00:00:00.000Z" }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toMatch(/current plan/i);
  });

  it("422s when no revision exists and the era reaches past createdAt", async () => {
    // With zero archived revisions the live plan has covered everything
    // since `createdAt` (2026-01-10); a manual era ending inside the
    // tracked window would re-score live compliance against the manual
    // snapshot. The boundary is createdAt, not "now".
    const res = await POST(
      postReq({
        ...VALID_BODY,
        validFrom: "2026-01-01T00:00:00.000Z",
        validUntil: "2026-02-01T00:00:00.000Z",
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toMatch(/current plan/i);
    expect(prisma.medicationScheduleRevision.create).not.toHaveBeenCalled();
  });

  it("creates a MANUAL revision with a daily snapshot entry", async () => {
    vi.mocked(prisma.medicationScheduleRevision.create).mockResolvedValue({
      id: "rev-new",
      validFrom: new Date(VALID_BODY.validFrom),
      validUntil: new Date(VALID_BODY.validUntil),
      source: "MANUAL",
      payload: [],
    } as never);

    const res = await POST(postReq(VALID_BODY), ROUTE_CTX);
    expect(res.status).toBe(201);

    const createArgs = vi.mocked(prisma.medicationScheduleRevision.create)
      .mock.calls[0][0] as unknown as {
      data: {
        medicationId: string;
        source: string;
        payload: Array<{
          timesOfDay: string[];
          rrule: string | null;
          windowStart: string;
          windowEnd: string;
          scheduleType: string;
        }>;
      };
    };
    expect(createArgs.data.medicationId).toBe("m1");
    expect(createArgs.data.source).toBe("MANUAL");
    expect(createArgs.data.payload).toHaveLength(1);
    // Times sorted ascending; window pulled to their min/max; daily.
    expect(createArgs.data.payload[0].timesOfDay).toEqual(["07:00", "19:00"]);
    expect(createArgs.data.payload[0].windowStart).toBe("07:00");
    expect(createArgs.data.payload[0].windowEnd).toBe("19:00");
    expect(createArgs.data.payload[0].rrule).toBe("FREQ=DAILY");
    expect(createArgs.data.payload[0].scheduleType).toBe("SCHEDULED");

    // History re-segmented — the rollup backfill must be enqueued.
    expect(enqueueUserMedicationComplianceBackfill).toHaveBeenCalledWith(
      "user-1",
    );
  });
});

describe("DELETE /api/medications/[id]/schedule-revisions/[revisionId]", () => {
  it("404s when the revision belongs to another medication", async () => {
    vi.mocked(
      prisma.medicationScheduleRevision.findUnique,
    ).mockResolvedValue({
      id: "rev-x",
      medicationId: "other-med",
      source: "MANUAL",
    } as never);
    const res = await DELETE(deleteReq("rev-x"), deleteCtx("rev-x"));
    expect(res.status).toBe(404);
    expect(prisma.medicationScheduleRevision.delete).not.toHaveBeenCalled();
  });

  it("409s for a write-path archive", async () => {
    vi.mocked(
      prisma.medicationScheduleRevision.findUnique,
    ).mockResolvedValue({
      id: "rev-a",
      medicationId: "m1",
      source: "ARCHIVED",
    } as never);
    const res = await DELETE(deleteReq("rev-a"), deleteCtx("rev-a"));
    expect(res.status).toBe(409);
    expect(prisma.medicationScheduleRevision.delete).not.toHaveBeenCalled();
  });

  it("deletes a MANUAL era and enqueues the rollup backfill", async () => {
    vi.mocked(
      prisma.medicationScheduleRevision.findUnique,
    ).mockResolvedValue({
      id: "rev-m",
      medicationId: "m1",
      source: "MANUAL",
    } as never);
    vi.mocked(prisma.medicationScheduleRevision.delete).mockResolvedValue(
      {} as never,
    );
    const res = await DELETE(deleteReq("rev-m"), deleteCtx("rev-m"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.deleted).toBe(true);
    expect(prisma.medicationScheduleRevision.delete).toHaveBeenCalledWith({
      where: { id: "rev-m" },
    });
    expect(enqueueUserMedicationComplianceBackfill).toHaveBeenCalledWith(
      "user-1",
    );
  });
});
