/**
 * v1.4.43 W6 — multi-issue 422 envelope on POST /api/mood-entries/bulk.
 * Preserves the `mood.bulk.invalid` errorCode meta passthrough.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    moodEntry: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
}));

// v1.12.0 — keep the real `RatedFactorOutOfRangeError` so the per-entry
// catch can `instanceof`-match a thrown out-of-scale rating.
vi.mock("@/lib/mood/tag-links", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mood/tag-links")>(
    "@/lib/mood/tag-links",
  );
  return {
    createTagLinks: vi.fn().mockResolvedValue(undefined),
    RatedFactorOutOfRangeError: actual.RatedFactorOutOfRangeError,
  };
});

vi.mock("@/lib/moodlog/push", () => ({
  pushMoodEntriesToMoodLog: vi.fn().mockResolvedValue(undefined),
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
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMood: vi.fn(),
}));
vi.mock("@/lib/rollups/mood-rollups", () => ({
  recomputeMoodBucketsForEntry: vi.fn().mockResolvedValue(undefined),
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
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { createTagLinks } from "@/lib/mood/tag-links";
import { pushMoodEntriesToMoodLog } from "@/lib/moodlog/push";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/mood-entries/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(createTagLinks).mockResolvedValue(undefined);
  // `vi.resetAllMocks()` above wipes the factory default, so the
  // best-effort reverse-sync push must be re-stubbed to a resolved
  // promise — the route calls `.catch()` on its return value.
  vi.mocked(pushMoodEntriesToMoodLog).mockResolvedValue({
    pushed: 0,
    skipped: 0,
    status: "skipped",
  });
});

describe("POST /api/mood-entries/bulk — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    const res = await POST(
      postReq({
        entries: [
          { mood: "junk", moodLoggedAt: "2026-01-01T00:00:00Z" },
          { mood: "happy", moodLoggedAt: "not-iso" },
        ],
      }),
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
    expect(body.meta?.errorCode).toBe("mood.bulk.invalid");
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("surfaces THREE simultaneous validation errors across entries", async () => {
    const res = await POST(
      postReq({
        entries: [
          { mood: "junk-1", moodLoggedAt: "2026-01-01T00:00:00Z" },
          { mood: "junk-2", moodLoggedAt: "not-iso" },
          { mood: "junk-3", moodLoggedAt: "also-not-iso" },
        ],
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
      meta?: { errorCode?: string };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
    expect(body.meta?.errorCode).toBe("mood.bulk.invalid");
  });

  it("writes a mood.bulk.validation-failed audit row", async () => {
    const res = await POST(
      postReq({
        entries: [
          { mood: "junk-1", moodLoggedAt: "2026-01-01T00:00:00Z" },
          { mood: "junk-2", moodLoggedAt: "not-iso" },
        ],
      }),
    );
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { userId: string; action: string };
    };
    expect(call.data.action).toBe("mood.bulk.validation-failed");
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(
      new Error("db down"),
    );
    const res = await POST(
      postReq({
        entries: [
          { mood: "junk-1", moodLoggedAt: "2026-01-01T00:00:00Z" },
          { mood: "junk-2", moodLoggedAt: "not-iso" },
        ],
      }),
    );
    expect(res.status).toBe(422);
  });
});

describe("POST /api/mood-entries/bulk — structured tagKeys (v1.12.0)", () => {
  beforeEach(() => {
    vi.mocked(prisma.moodEntry.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.moodEntry.upsert).mockResolvedValue({
      id: "entry-1",
    } as never);
  });

  it("persists structured tag links for an entry carrying tagKeys", async () => {
    const res = await POST(
      postReq({
        entries: [
          {
            mood: "GUT",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            tagKeys: ["movies", "gaming"],
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(createTagLinks).toHaveBeenCalledTimes(1);
    // v1.12.0 — the bulk path now also threads the prisma client (3rd arg,
    // outside the upsert tx) and the rated-factor set (4th, empty here).
    expect(createTagLinks).toHaveBeenCalledWith(
      "entry-1",
      "user-1",
      ["movies", "gaming"],
      prisma,
      [],
    );
  });

  it("skips the tag-link write when an entry sends no tagKeys", async () => {
    const res = await POST(
      postReq({
        entries: [{ mood: "OKAY", moodLoggedAt: "2026-05-16T08:00:00.000Z" }],
      }),
    );
    expect(res.status).toBe(200);
    expect(createTagLinks).not.toHaveBeenCalled();
  });

  it("strips an over-long tagKeys array at the schema boundary (422)", async () => {
    const res = await POST(
      postReq({
        entries: [
          {
            mood: "OKAY",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            tagKeys: Array.from({ length: 31 }, (_, i) => `k${i}`),
          },
        ],
      }),
    );
    expect(res.status).toBe(422);
    expect(createTagLinks).not.toHaveBeenCalled();
  });

  it("threads ratedFactors into createTagLinks for a bulk entry", async () => {
    const res = await POST(
      postReq({
        entries: [
          {
            mood: "GUT",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            tagKeys: ["movies"],
            ratedFactors: [{ key: "factor_work", rating: 4 }],
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { inserted: number } };
    expect(json.data.inserted).toBe(1);
    expect(createTagLinks).toHaveBeenCalledWith(
      "entry-1",
      "user-1",
      ["movies"],
      prisma,
      [{ key: "factor_work", rating: 4 }],
    );
  });

  it("dedups on (userId, source, externalId) when an entry carries externalId", async () => {
    vi.mocked(prisma.moodEntry.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.moodEntry.upsert).mockResolvedValue({
      id: "entry-ext",
    } as never);
    const res = await POST(
      postReq({
        entries: [
          {
            mood: "GUT",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            externalId: "ios-uuid-1",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { inserted: number; entries: Array<{ externalId?: string }> };
    };
    expect(json.data.inserted).toBe(1);
    // The probe + upsert both key on the externalId compound, not the
    // legacy wall-clock tuple.
    const probeWhere = vi.mocked(prisma.moodEntry.findUnique).mock.calls[0]?.[0]
      ?.where as Record<string, unknown>;
    expect(probeWhere).toHaveProperty("userId_source_externalId");
    const upsertArg = vi.mocked(prisma.moodEntry.upsert).mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      create: { externalId: string | null; source: string };
    };
    expect(upsertArg.where).toHaveProperty("userId_source_externalId");
    expect(upsertArg.create.externalId).toBe("ios-uuid-1");
    // The per-entry result echoes the externalId back for iOS hydration.
    expect(json.data.entries[0].externalId).toBe("ios-uuid-1");
  });

  it("uses the legacy wall-clock key and omits externalId when none is sent", async () => {
    vi.mocked(prisma.moodEntry.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.moodEntry.upsert).mockResolvedValue({
      id: "entry-legacy",
    } as never);
    const res = await POST(
      postReq({
        entries: [{ mood: "OKAY", moodLoggedAt: "2026-05-16T08:00:00.000Z" }],
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { entries: Array<{ externalId?: string }> };
    };
    const probeWhere = vi.mocked(prisma.moodEntry.findUnique).mock.calls[0]?.[0]
      ?.where as Record<string, unknown>;
    expect(probeWhere).toHaveProperty("userId_date_moodLoggedAt");
    expect(json.data.entries[0].externalId).toBeUndefined();
  });

  it("reports a re-posted externalId entry as a duplicate (idempotent)", async () => {
    // Probe finds the row → the response classifies it duplicate, not
    // inserted, and the upsert update branch refreshes it in place.
    vi.mocked(prisma.moodEntry.findUnique).mockResolvedValue({
      id: "entry-ext",
    } as never);
    vi.mocked(prisma.moodEntry.upsert).mockResolvedValue({
      id: "entry-ext",
    } as never);
    const res = await POST(
      postReq({
        entries: [
          {
            mood: "SUPER_GUT",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            externalId: "ios-uuid-1",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { inserted: number; duplicates: number };
    };
    expect(json.data.inserted).toBe(0);
    expect(json.data.duplicates).toBe(1);
    const upsertArg = vi.mocked(prisma.moodEntry.upsert).mock.calls[0]?.[0] as {
      update: Record<string, unknown>;
    };
    // The externalId update branch also refreshes date + moodLoggedAt.
    expect(upsertArg.update).toHaveProperty("date");
    expect(upsertArg.update).toHaveProperty("moodLoggedAt");
  });

  it("rejects an over-long externalId at the Zod boundary (422)", async () => {
    const res = await POST(
      postReq({
        entries: [
          {
            mood: "OKAY",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            externalId: "x".repeat(121),
          },
        ],
      }),
    );
    expect(res.status).toBe(422);
    expect(prisma.moodEntry.upsert).not.toHaveBeenCalled();
  });

  it("marks the single entry skipped (not the batch) on an out-of-scale rating", async () => {
    const { RatedFactorOutOfRangeError } = await import("@/lib/mood/tag-links");
    // First entry's factor write throws; the loop catch records it skipped.
    vi.mocked(createTagLinks).mockRejectedValueOnce(
      new RatedFactorOutOfRangeError("factor_conflict", 5, 1, 2),
    );
    const res = await POST(
      postReq({
        entries: [
          {
            mood: "GUT",
            moodLoggedAt: "2026-05-16T08:00:00.000Z",
            ratedFactors: [{ key: "factor_conflict", rating: 5 }],
          },
          {
            mood: "OKAY",
            moodLoggedAt: "2026-05-16T09:00:00.000Z",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        processed: number;
        inserted: number;
        entries: Array<{ index: number; status: string }>;
      };
    };
    expect(json.data.processed).toBe(2);
    // Entry 0 skipped (bad factor), entry 1 inserted clean.
    expect(json.data.entries[0].status).toBe("skipped");
    expect(json.data.entries[1].status).toBe("inserted");
  });
});
