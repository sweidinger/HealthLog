import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * v1.25.0 — `POST /api/mental-health/assessments` happy path.
 *
 * Regression guard for the dead-on-arrival bug: the handler used to pass the
 * `safeJson` `{ data, error }` WRAPPER straight into `safeParse`, so the schema
 * never matched and every POST returned 422. This pins that a valid body now
 * (a) parses, (b) persists with a server-authoritative total / band / item-9
 * flag, (c) writes the derived `*_SCORE` Measurement, and (d) surfaces the
 * locale-aware crisis set on a positive item 9.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    mentalHealthAssessment: { create: vi.fn(), findFirst: vi.fn() },
    measurement: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("@/lib/modules/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules/gate")>()),
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
  resolveModuleMap: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi
    .fn()
    .mockResolvedValue({ allowed: true, remaining: 29, resetAt: Date.now() }),
  rateLimitHeaders: vi.fn().mockReturnValue({}),
}));

vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  encryptToBytes: vi.fn(() => Buffer.from("ciphertext")),
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

import { POST } from "../route";
import { getSession } from "@/lib/auth/session";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "testuser",
    role: "USER" as const,
    locale: "en",
  },
};

const callPost = POST as unknown as (req: NextRequest) => Promise<Response>;

function makeReq(body: unknown): NextRequest {
  return new NextRequest(
    new URL("http://localhost/api/mental-health/assessments"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true });
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 29,
    resetAt: Date.now(),
  });
  // No prior administration by default; the dedup test overrides this.
  vi.mocked(prisma.mentalHealthAssessment.findFirst).mockResolvedValue(
    null as never,
  );
});

describe("POST /api/mental-health/assessments", () => {
  it("parses a valid PHQ-9 body and returns 201 with the server-computed total/band/flag", async () => {
    // Item 9 = 2 → safety-flagged; total = 8*1 + 2 = 10 → moderate band.
    vi.mocked(prisma.mentalHealthAssessment.create).mockResolvedValue({
      id: "mha_1",
      instrument: "PHQ9",
      locale: "en",
      version: "standard",
      totalScore: 10,
      severityBand: "moderate",
      item9Flagged: true,
      crisisShownAt: new Date("2026-06-28T00:00:00.000Z"),
      takenAt: new Date("2026-06-28T00:00:00.000Z"),
      createdAt: new Date("2026-06-28T00:00:00.000Z"),
    } as never);

    const res = await callPost(
      makeReq({
        instrument: "PHQ9",
        items: [1, 1, 1, 1, 1, 1, 1, 1, 2],
        locale: "en",
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: {
        assessment: {
          totalScore: number;
          severityBand: string;
          item9Flagged: boolean;
        };
        actionThreshold: number;
        crisis: { emergencyNumber: string } | null;
      };
    };
    expect(body.data.assessment.totalScore).toBe(10);
    expect(body.data.assessment.severityBand).toBe("moderate");
    expect(body.data.assessment.item9Flagged).toBe(true);
    expect(body.data.actionThreshold).toBe(10);
    // Positive item 9 → crisis resources surfaced immediately.
    expect(body.data.crisis).not.toBeNull();
    expect(body.data.crisis?.emergencyNumber).toBeTruthy();
  });

  it("persists server-authoritative scoring (userId from session, total recomputed) + the derived measurement", async () => {
    vi.mocked(prisma.mentalHealthAssessment.create).mockResolvedValue({
      id: "mha_2",
      instrument: "GAD7",
      locale: "en",
      version: "standard",
      totalScore: 6,
      severityBand: "mild",
      item9Flagged: false,
      crisisShownAt: null,
      takenAt: new Date("2026-06-28T00:00:00.000Z"),
      createdAt: new Date("2026-06-28T00:00:00.000Z"),
    } as never);

    // GAD-7, total 1+2+0+1+1+1+0 = 6 → mild, no safety item.
    const res = await callPost(
      makeReq({
        instrument: "GAD7",
        items: [1, 2, 0, 1, 1, 1, 0],
      }),
    );
    expect(res.status).toBe(201);

    const createArg = vi.mocked(prisma.mentalHealthAssessment.create).mock
      .calls[0][0] as {
      data: {
        userId: string;
        instrument: string;
        totalScore: number;
        severityBand: string;
        item9Flagged: boolean;
      };
    };
    expect(createArg.data.userId).toBe("user-1");
    expect(createArg.data.instrument).toBe("GAD7");
    expect(createArg.data.totalScore).toBe(6);
    expect(createArg.data.severityBand).toBe("mild");
    expect(createArg.data.item9Flagged).toBe(false);

    // Derived projection: one PHQ9_SCORE/GAD7_SCORE Measurement per assessment.
    // Server-owned: the row carries the COMPUTED source (the RECOVERY_SCORE
    // precedent) — a client can never attribute COMPUTED on a write surface,
    // so the trend cannot be forged through the measurement POST.
    const measArg = vi.mocked(prisma.measurement.create).mock.calls[0][0] as {
      data: {
        type: string;
        value: number;
        unit: string;
        source: string;
        externalId: string;
      };
    };
    expect(measArg.data.type).toBe("GAD7_SCORE");
    expect(measArg.data.value).toBe(6);
    expect(measArg.data.unit).toBe("score");
    expect(measArg.data.source).toBe("COMPUTED");
    expect(measArg.data.externalId).toBe("assessment:mha_2");
  });

  it("dedups a repeat externalId: returns the existing administration, writes nothing new", async () => {
    // The outbox replays a queued check-in with the same client externalId.
    vi.mocked(prisma.mentalHealthAssessment.findFirst).mockResolvedValue({
      id: "mha_dup",
      instrument: "PHQ9",
      locale: "en",
      version: "standard",
      totalScore: 4,
      severityBand: "mild",
      item9Flagged: false,
      crisisShownAt: null,
      takenAt: new Date("2026-06-28T00:00:00.000Z"),
      createdAt: new Date("2026-06-28T00:00:00.000Z"),
    } as never);

    const res = await callPost(
      makeReq({
        instrument: "PHQ9",
        items: [1, 1, 1, 1, 0, 0, 0, 0, 0],
        source: "IOS",
        externalId: "outbox-7f3c",
      }),
    );

    // Existing row returned (200, not 201) — no duplicate assessment or trend point.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { assessment: { id: string } };
    };
    expect(body.data.assessment.id).toBe("mha_dup");
    expect(prisma.mentalHealthAssessment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", externalId: "outbox-7f3c" },
      }),
    );
    expect(prisma.mentalHealthAssessment.create).not.toHaveBeenCalled();
    expect(prisma.measurement.create).not.toHaveBeenCalled();
  });

  it("persists client provenance + externalId on a first write", async () => {
    vi.mocked(prisma.mentalHealthAssessment.create).mockResolvedValue({
      id: "mha_3",
      instrument: "GAD7",
      locale: "en",
      version: "standard",
      totalScore: 3,
      severityBand: "mild",
      item9Flagged: false,
      crisisShownAt: null,
      takenAt: new Date("2026-06-28T00:00:00.000Z"),
      createdAt: new Date("2026-06-28T00:00:00.000Z"),
    } as never);

    const res = await callPost(
      makeReq({
        instrument: "GAD7",
        items: [1, 1, 1, 0, 0, 0, 0],
        source: "IOS",
        externalId: "outbox-aa01",
      }),
    );
    expect(res.status).toBe(201);

    const createArg = vi.mocked(prisma.mentalHealthAssessment.create).mock
      .calls[0][0] as { data: { source: string; externalId: string | null } };
    expect(createArg.data.source).toBe("IOS");
    expect(createArg.data.externalId).toBe("outbox-aa01");
  });

  it("rejects a wrong item count with 422 and never writes", async () => {
    const res = await callPost(
      makeReq({ instrument: "PHQ9", items: [1, 2, 3] }), // 3 ≠ 9
    );
    expect(res.status).toBe(422);
    expect(prisma.mentalHealthAssessment.create).not.toHaveBeenCalled();
  });

  it("returns the module 403 when the mental-health module is off", async () => {
    const { apiError } = await import("@/lib/api-response");
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: false,
      response: apiError("disabled", 403, { errorCode: "module.disabled" }),
    });
    const res = await callPost(
      makeReq({ instrument: "PHQ9", items: [0, 0, 0, 0, 0, 0, 0, 0, 0] }),
    );
    expect(res.status).toBe(403);
    expect(prisma.mentalHealthAssessment.create).not.toHaveBeenCalled();
  });
});
