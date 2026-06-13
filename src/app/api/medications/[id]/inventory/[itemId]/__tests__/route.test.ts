/**
 * v1.4.43 W6 — multi-issue 422 envelope on PATCH
 * /api/medications/[id]/inventory/[itemId].
 *
 * v1.16.1 — stock-correction contract: `unitsRemaining` sets the count
 * absolutely, clamps to `unitsTotal`, and the canonical state machine
 * derives the next state (0 ⇒ USED_UP).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: { findUnique: vi.fn() },
    medicationInventoryItem: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/medications/inventory/service", () => ({
  computeExpiresAt: vi.fn().mockReturnValue(null),
  buildPatchInventoryUpdate: vi.fn().mockReturnValue({}),
  // v1.16.12 — the route serialises its Decimal unit columns to numbers
  // on the way out; a passthrough keeps these update-logic assertions
  // focused on the Prisma call, not the response shape.
  serializeInventoryItem: <T,>(item: T) => item,
}));
vi.mock("@/lib/medications/route-guards", () => ({
  assertMedicationOwnership: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: () => ({}),
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

import { PATCH } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function patchReq(body: unknown): NextRequest {
  return new NextRequest(
    "http://localhost/api/medications/m1/inventory/i1",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

const ROUTE_CTX = {
  params: Promise.resolve({ id: "m1", itemId: "i1" }),
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(prisma.medicationInventoryItem.findUnique).mockResolvedValue({
    id: "i1",
    medicationId: "m1",
    userId: "user-1",
    firstUseAt: null,
    state: "ACTIVE",
    unitsRemaining: 4,
    printedExpiry: null,
  } as never);
});

describe("PATCH /api/medications/[id]/inventory/[itemId] — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    // Bad `markAsFirstUseAt` iso + bad `markAsUsedUp` (not boolean).
    const res = await PATCH(
      patchReq({ markAsFirstUseAt: "not-iso", markAsUsedUp: "string" }),
      ROUTE_CTX,
    );
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

  it("surfaces THREE simultaneous validation errors", async () => {
    const res = await PATCH(
      patchReq({
        markAsFirstUseAt: "not-iso",
        markAsUsedUp: "string",
        printedExpiry: "also-bad",
        notes: 123,
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe("PATCH /api/medications/[id]/inventory/[itemId] — unitsRemaining stock correction (v1.16.1)", () => {
  beforeEach(() => {
    vi.mocked(prisma.medicationInventoryItem.findUnique).mockResolvedValue({
      id: "i1",
      medicationId: "m1",
      userId: "user-1",
      firstUseAt: null,
      state: "IN_USE",
      unitsTotal: 4,
      unitsRemaining: 3,
      printedExpiry: null,
      notes: null,
    } as never);
    vi.mocked(prisma.medicationInventoryItem.update).mockImplementation(
      (async (args: { data: Record<string, unknown> }) => ({
        id: "i1",
        ...args.data,
      })) as never,
    );
  });

  it("sets the remaining count absolutely", async () => {
    const res = await PATCH(patchReq({ unitsRemaining: 1 }), ROUTE_CTX);
    expect(res.status).toBe(200);
    const update = vi.mocked(prisma.medicationInventoryItem.update).mock
      .calls[0][0] as unknown as { data: { unitsRemaining: number } };
    expect(update.data.unitsRemaining).toBe(1);
  });

  it("derives USED_UP when corrected to zero", async () => {
    const res = await PATCH(patchReq({ unitsRemaining: 0 }), ROUTE_CTX);
    expect(res.status).toBe(200);
    const update = vi.mocked(prisma.medicationInventoryItem.update).mock
      .calls[0][0] as unknown as { data: { unitsRemaining: number; state: string } };
    expect(update.data.unitsRemaining).toBe(0);
    expect(update.data.state).toBe("USED_UP");
  });

  it("clamps a raise above the item's capacity to unitsTotal", async () => {
    const res = await PATCH(patchReq({ unitsRemaining: 99 }), ROUTE_CTX);
    expect(res.status).toBe(200);
    const update = vi.mocked(prisma.medicationInventoryItem.update).mock
      .calls[0][0] as unknown as { data: { unitsRemaining: number } };
    expect(update.data.unitsRemaining).toBe(4);
  });

  it("rejects a negative correction with 422", async () => {
    const res = await PATCH(patchReq({ unitsRemaining: -1 }), ROUTE_CTX);
    expect(res.status).toBe(422);
  });
});
