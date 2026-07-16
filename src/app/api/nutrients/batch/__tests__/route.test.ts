/**
 * v1.28 — `POST /api/nutrients/batch` contract tests.
 *
 * Pins the ingest posture: module gate first (403 `module.disabled`),
 * per-entry skip guards (unit mismatch / plausibility / day key), the
 * insert-vs-update statuses off the composite-PK probe, and the batch
 * envelope errors (`too_large`, multi-issue `invalid`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    nutrientIntakeDay: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
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
import { auditLog } from "@/lib/auth/audit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/nutrients/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Yesterday's UTC day key — always a valid, in-window day. */
function recentDay(offsetDays = 1): string {
  return new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

interface BatchResponse {
  data: {
    processed: number;
    inserted: number;
    updated: number;
    skipped: Array<{ index: number; reason: string }>;
    entries: Array<{ index: number; status: string; reason?: string }>;
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true });
  vi.mocked(auditLog).mockResolvedValue(undefined as never);
  vi.mocked(prisma.nutrientIntakeDay.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.nutrientIntakeDay.upsert).mockResolvedValue({} as never);
});

describe("POST /api/nutrients/batch — module gate", () => {
  it("refuses ingest with the 403 module.disabled envelope when the module is off", async () => {
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: false,
      response: apiError('Module "nutrients" is not enabled', 403, {
        errorCode: "module.disabled",
        module: "nutrients",
      }),
    });

    const res = await POST(
      postReq({
        entries: [
          { day: recentDay(), nutrient: "vitamin_d", unit: "ug", amount: 20 },
        ],
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      data: null;
      meta?: { errorCode?: string; module?: string };
    };
    expect(body.data).toBeNull();
    expect(body.meta?.errorCode).toBe("module.disabled");
    expect(body.meta?.module).toBe("nutrients");
    expect(prisma.nutrientIntakeDay.upsert).not.toHaveBeenCalled();
  });
});

describe("POST /api/nutrients/batch — envelope errors", () => {
  it("rejects a 501-entry batch with 422 nutrient.batch.too_large before Zod", async () => {
    const entries = Array.from({ length: 501 }, () => ({
      day: recentDay(),
      nutrient: "vitamin_c",
      unit: "mg",
      amount: 100,
    }));
    const res = await POST(postReq({ entries }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("nutrient.batch.too_large");
  });

  it("surfaces multiple simultaneous Zod issues as one 422 nutrient.batch.invalid", async () => {
    const res = await POST(
      postReq({
        entries: [
          { day: "not-a-day", nutrient: "vitamin_d", unit: "ug", amount: 20 },
          { day: recentDay(), nutrient: "kryptonite", unit: "mg", amount: 1 },
          { day: recentDay(), nutrient: "iron", unit: "mg", amount: -5 },
        ],
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: unknown[] };
      meta?: { errorCode?: string };
    };
    expect(body.meta?.errorCode).toBe("nutrient.batch.invalid");
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("returns 429 when the per-user rate bucket is exhausted", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    const res = await POST(
      postReq({
        entries: [
          { day: recentDay(), nutrient: "water", unit: "ml", amount: 1500 },
        ],
      }),
    );
    expect(res.status).toBe(429);
  });
});

describe("POST /api/nutrients/batch — per-entry skip guards", () => {
  it("skips a unit mismatch (µg posted as mg) without touching the store", async () => {
    const res = await POST(
      postReq({
        entries: [
          // vitamin_d is canonically µg; posting mg is the 1000× hazard.
          { day: recentDay(), nutrient: "vitamin_d", unit: "mg", amount: 20 },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as BatchResponse;
    expect(body.data.entries[0]).toEqual({
      index: 0,
      status: "skipped",
      reason: "unit_mismatch",
    });
    expect(body.data.skipped).toEqual([{ index: 0, reason: "unit_mismatch" }]);
    expect(prisma.nutrientIntakeDay.upsert).not.toHaveBeenCalled();
  });

  it("skips a value above the plausibility cap", async () => {
    const res = await POST(
      postReq({
        entries: [
          // caffeine cap is 2000 mg.
          { day: recentDay(), nutrient: "caffeine", unit: "mg", amount: 2001 },
        ],
      }),
    );
    const body = (await res.json()) as BatchResponse;
    expect(body.data.entries[0].status).toBe("skipped");
    expect(body.data.entries[0].reason).toBe("value_out_of_range");
    expect(prisma.nutrientIntakeDay.upsert).not.toHaveBeenCalled();
  });

  it("skips an impossible calendar day and a far-future day as day_invalid", async () => {
    const res = await POST(
      postReq({
        entries: [
          // Regex-shaped but not a real date.
          { day: "2026-02-31", nutrient: "iron", unit: "mg", amount: 10 },
          // Beyond tomorrow in every IANA timezone.
          { day: "2999-01-01", nutrient: "iron", unit: "mg", amount: 10 },
        ],
      }),
    );
    const body = (await res.json()) as BatchResponse;
    expect(body.data.entries.map((e) => e.reason)).toEqual([
      "day_invalid",
      "day_invalid",
    ]);
    expect(prisma.nutrientIntakeDay.upsert).not.toHaveBeenCalled();
  });

  it("a skipped entry never fails the batch — siblings still land", async () => {
    const res = await POST(
      postReq({
        entries: [
          { day: recentDay(), nutrient: "vitamin_d", unit: "mg", amount: 20 },
          { day: recentDay(), nutrient: "magnesium", unit: "mg", amount: 300 },
        ],
      }),
    );
    const body = (await res.json()) as BatchResponse;
    expect(body.data.processed).toBe(2);
    expect(body.data.inserted).toBe(1);
    expect(body.data.skipped).toHaveLength(1);
    expect(prisma.nutrientIntakeDay.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/nutrients/batch — upsert semantics", () => {
  it("reports inserted for a fresh (day, nutrient) and writes the catalog's canonical unit", async () => {
    const day = recentDay();
    const res = await POST(
      postReq({
        entries: [
          {
            day,
            nutrient: "vitamin_d",
            unit: "ug",
            amount: 22.5,
            externalSourceVersion: "yazio-9.9",
          },
        ],
      }),
    );
    const body = (await res.json()) as BatchResponse;
    expect(body.data.inserted).toBe(1);
    expect(body.data.updated).toBe(0);
    expect(body.data.entries[0].status).toBe("inserted");

    expect(prisma.nutrientIntakeDay.upsert).toHaveBeenCalledWith({
      where: {
        userId_day_nutrient: {
          userId: "user-1",
          day,
          nutrient: "vitamin_d",
        },
      },
      create: {
        userId: "user-1",
        day,
        nutrient: "vitamin_d",
        amount: 22.5,
        unit: "ug",
        externalSourceVersion: "yazio-9.9",
      },
      update: {
        amount: 22.5,
        unit: "ug",
        externalSourceVersion: "yazio-9.9",
      },
    });
  });

  it("reports updated (never duplicate) when the composite key already exists", async () => {
    vi.mocked(prisma.nutrientIntakeDay.findUnique).mockResolvedValue({
      userId: "user-1",
    } as never);

    const res = await POST(
      postReq({
        entries: [
          { day: recentDay(), nutrient: "caffeine", unit: "mg", amount: 310 },
        ],
      }),
    );
    const body = (await res.json()) as BatchResponse;
    expect(body.data.inserted).toBe(0);
    expect(body.data.updated).toBe(1);
    expect(body.data.entries[0].status).toBe("updated");
    expect(
      body.data.entries.some((e) => e.status === ("duplicate" as string)),
    ).toBe(false);
  });

  it("writes the audit-ledger breadcrumb only when at least one row landed", async () => {
    await POST(
      postReq({
        entries: [
          { day: recentDay(), nutrient: "vitamin_d", unit: "mg", amount: 20 },
        ],
      }),
    );
    expect(auditLog).not.toHaveBeenCalled();

    await POST(
      postReq({
        entries: [
          { day: recentDay(), nutrient: "water", unit: "ml", amount: 1800 },
        ],
      }),
    );
    expect(auditLog).toHaveBeenCalledWith(
      "nutrient.batch.ingest",
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("a thrown upsert marks only that entry skipped upsert_failed without leaking the raw error", async () => {
    // The exception message must never reach the client — the per-entry
    // `reason` is a closed set. A raw-message echo was a v1.28.48 fix.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(prisma.nutrientIntakeDay.upsert)
      .mockRejectedValueOnce(new Error("boom: sensitive db detail"))
      .mockResolvedValueOnce({} as never);

    const res = await POST(
      postReq({
        entries: [
          { day: recentDay(), nutrient: "zinc", unit: "mg", amount: 10 },
          { day: recentDay(), nutrient: "iron", unit: "mg", amount: 12 },
        ],
      }),
    );
    const body = (await res.json()) as BatchResponse;
    expect(body.data.entries[0].status).toBe("skipped");
    expect(body.data.entries[0].reason).toBe("upsert_failed");
    expect(body.data.skipped[0].reason).toBe("upsert_failed");
    // The raw exception text is logged server-side only, never echoed.
    expect(JSON.stringify(body)).not.toContain("sensitive db detail");
    expect(spy).toHaveBeenCalled();
    expect(body.data.entries[1].status).toBe("inserted");
    expect(body.data.inserted).toBe(1);
    spy.mockRestore();
  });
});
