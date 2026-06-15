import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/coach/about-me/adopt — locks the read-modify-write.
 *
 * The original handler read the self-context through the global client,
 * computed the appended value, then upserted: two concurrent adoptions
 * could read the same base value and one append silently lost. The
 * suite pins the transactional shape — empty upsert → `FOR UPDATE` row
 * lock → read through the SAME `tx` client → single-column update —
 * so a refactor can't quietly fall back to the racy read.
 */

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1" } })),
}));

const tx = {
  userHealthProfile: {
    upsert: vi.fn(),
    update: vi.fn(),
    findUnique: vi.fn(),
  },
  $queryRaw: vi.fn(),
};

vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  },
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  rateLimitHeaders: vi.fn(() => ({})),
}));
vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  encryptToBytes: (s: string) => Buffer.from(s),
}));
vi.mock("@/lib/ai/coach/about-me", () => ({
  getSelfContextForUser: vi.fn(),
}));
vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(async () => ({ enabled: true })),
}));

vi.mock("@/lib/api-response", () => ({
  apiSuccess: (data: unknown) => ({ data, error: null, status: 200 }),
  apiError: (error: string, status: number, meta?: unknown) => ({
    data: null,
    error,
    status,
    meta,
  }),
  getClientIp: () => "127.0.0.1",
  returnAllZodIssues: (_e: unknown, status: number) => ({
    data: null,
    error: "validation",
    status,
  }),
  safeJson: async (req: Request) => ({ data: await req.json(), error: null }),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { getSelfContextForUser } from "@/lib/ai/coach/about-me";
import { requireModuleEnabled } from "@/lib/modules/gate";

const transaction = prisma.$transaction as ReturnType<typeof vi.fn>;
const getCtx = getSelfContextForUser as ReturnType<typeof vi.fn>;
const gate = requireModuleEnabled as ReturnType<typeof vi.fn>;

function adoptRequest(body: { question?: string; answer: string }): Request {
  return new Request("http://localhost/api/coach/about-me/adopt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

type Envelope = { data: unknown; error: string | null; status: number };
const post = POST as unknown as (req: Request) => Promise<Envelope>;

const emptyCtx = {
  aboutMe: null,
  conditions: null,
  allergies: null,
  coachFocus: null,
};

describe("POST /api/coach/about-me/adopt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx.userHealthProfile.upsert.mockResolvedValue({ id: "p1" });
    tx.userHealthProfile.update.mockResolvedValue({ updatedAt: new Date() });
    tx.$queryRaw.mockResolvedValue([{ id: "p1" }]);
    gate.mockResolvedValue({ enabled: true });
  });

  // v1.18.0 — Coach module gate (operator availability OR per-user
  // disableCoach) short-circuits before the locked read-modify-write.
  it("returns 403 module.disabled when Coach is disabled, without a write", async () => {
    gate.mockResolvedValue({
      enabled: false,
      response: {
        data: null,
        error: 'Module "coach" is not enabled',
        status: 403,
        meta: { errorCode: "module.disabled", module: "coach" },
      },
    });

    const res = await post(
      adoptRequest({ question: "What matters?", answer: "evening walks" }),
    );

    expect(res.status).toBe(403);
    expect(gate).toHaveBeenCalledWith("u1", "coach");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("runs the read-modify-write inside one transaction with a row lock", async () => {
    getCtx.mockResolvedValue(emptyCtx);

    const res = await post(
      adoptRequest({ question: "What matters?", answer: "evening walks" }),
    );

    expect(res.status).toBe(200);
    expect(res.data).toEqual({ adopted: true, field: "coachFocus" });
    expect(transaction).toHaveBeenCalledTimes(1);
    // Row pinned, then locked FOR UPDATE before the read.
    expect(tx.userHealthProfile.upsert).toHaveBeenCalledWith({
      where: { userId: "u1" },
      create: { userId: "u1" },
      update: {},
      select: { id: true },
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    // The read goes through the SAME tx client, not the global one.
    expect(getCtx).toHaveBeenCalledWith("u1", tx);
    // Exactly one encrypted column written.
    const data = tx.userHealthProfile.update.mock.calls[0][0].data;
    expect(Object.keys(data)).toEqual(["coachFocusEncrypted"]);
  });

  it("dedupes inside the locked section without writing", async () => {
    getCtx.mockResolvedValue({ ...emptyCtx, coachFocus: "Evening walks" });

    const res = await post(
      adoptRequest({ question: "What matters?", answer: "evening walks" }),
    );

    expect(res.data).toEqual({
      adopted: false,
      field: "coachFocus",
      reason: "duplicate",
    });
    expect(tx.userHealthProfile.update).not.toHaveBeenCalled();
  });

  it("appends to an existing value read under the lock", async () => {
    getCtx.mockResolvedValue({ ...emptyCtx, allergies: "pollen" });

    const res = await post(
      adoptRequest({ question: "Any allergies?", answer: "penicillin" }),
    );

    expect(res.data).toEqual({ adopted: true, field: "allergies" });
    const data = tx.userHealthProfile.update.mock.calls[0][0].data;
    expect(Buffer.from(data.allergiesEncrypted).toString()).toBe(
      "pollen\npenicillin",
    );
  });

  // v1.16.8 — the remember action on a chat message sends only the
  // message text; the target field is matched from the text itself.
  it("matches the field from the answer text when no question is sent", async () => {
    getCtx.mockResolvedValue(emptyCtx);

    const res = await post(
      adoptRequest({ answer: "Ich habe eine Erdnussallergie" }),
    );

    expect(res.status).toBe(200);
    expect(res.data).toEqual({ adopted: true, field: "allergies" });
    const data = tx.userHealthProfile.update.mock.calls[0][0].data;
    expect(Object.keys(data)).toEqual(["allergiesEncrypted"]);
  });

  it("lands a question-less answer without keywords on coachFocus", async () => {
    getCtx.mockResolvedValue(emptyCtx);

    const res = await post(
      adoptRequest({ answer: "Ich gehe abends gern spazieren" }),
    );

    expect(res.data).toEqual({ adopted: true, field: "coachFocus" });
    const data = tx.userHealthProfile.update.mock.calls[0][0].data;
    expect(Object.keys(data)).toEqual(["coachFocusEncrypted"]);
  });

  it("still 422s on an empty answer regardless of the question", async () => {
    const res = await post(adoptRequest({ answer: "   " }));
    expect(res.status).toBe(422);
    expect(tx.userHealthProfile.update).not.toHaveBeenCalled();
  });

  it("422s when the overflow target aboutMe is full, still without a write", async () => {
    getCtx.mockResolvedValue({
      ...emptyCtx,
      coachFocus: "x".repeat(499),
      aboutMe: "y".repeat(3999),
    });

    const res = await post(
      adoptRequest({ question: "What matters?", answer: "z".repeat(10) }),
    );

    expect(res.status).toBe(422);
    expect(tx.userHealthProfile.update).not.toHaveBeenCalled();
  });
});
