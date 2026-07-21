/**
 * Fork ADHS Stage C — dose-change DELETE route tests.
 *
 * Pins the guard shape shared with the sibling glp1 POST: auth, ownership
 * 404, a 404 for a missing step OR a step that belongs to a DIFFERENT
 * medication (so a cross-medication id probe can't distinguish the two), the
 * audit-log write, and the happy-path delete. Prisma + guards are mocked so no
 * testcontainer boots.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medicationDoseChange: { findUnique: vi.fn(), delete: vi.fn() },
  },
}));

vi.mock("@/lib/medications/route-guards", () => ({
  assertMedicationOwnership: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 29,
    resetAt: Date.now() + 60_000,
  }),
  rateLimitHeaders: vi.fn(() => ({ "X-RateLimit-Remaining": "0" })),
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMedications: vi.fn(),
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

import { DELETE } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

function req(): NextRequest {
  return new NextRequest(
    "http://localhost/api/medications/med-1/glp1/dose-change/dc-1",
    { method: "DELETE" },
  );
}

function params(id = "med-1", changeId = "dc-1") {
  return { params: Promise.resolve({ id, changeId }) };
}

beforeEach(() => {
  vi.resetAllMocks();
  // resetAllMocks clears the return values set in the vi.mock factories, so
  // re-arm the guards the happy path depends on.
  vi.mocked(assertMedicationOwnership).mockResolvedValue(null);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 29,
    resetAt: Date.now() + 60_000,
  } as never);
});

describe("DELETE /api/medications/[id]/glp1/dose-change/[changeId]", () => {
  it("rejects unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await DELETE(req(), params());
    expect(res.status).toBe(401);
  });

  it("returns 404 when the medication is not the caller's", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(assertMedicationOwnership).mockResolvedValueOnce(
      new Response(null, { status: 404 }) as never,
    );
    const res = await DELETE(req(), params());
    expect(res.status).toBe(404);
  });

  it("returns 404 when the dose change does not exist", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medicationDoseChange.findUnique).mockResolvedValue(
      null as never,
    );
    const res = await DELETE(req(), params());
    expect(res.status).toBe(404);
    expect(prisma.medicationDoseChange.delete).not.toHaveBeenCalled();
  });

  it("returns 404 when the dose change belongs to a different medication", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medicationDoseChange.findUnique).mockResolvedValue({
      id: "dc-1",
      medicationId: "other-med",
    } as never);
    const res = await DELETE(req(), params());
    expect(res.status).toBe(404);
    expect(prisma.medicationDoseChange.delete).not.toHaveBeenCalled();
  });

  it("deletes the step, writes an audit row, and returns the id", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medicationDoseChange.findUnique).mockResolvedValue({
      id: "dc-1",
      medicationId: "med-1",
    } as never);
    vi.mocked(prisma.medicationDoseChange.delete).mockResolvedValue({
      id: "dc-1",
    } as never);
    const res = await DELETE(req(), params());
    expect(res.status).toBe(200);
    expect(prisma.medicationDoseChange.delete).toHaveBeenCalledWith({
      where: { id: "dc-1" },
    });
    expect(auditLog).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { data: { deleted: string } };
    expect(body.data.deleted).toBe("dc-1");
  });
});
