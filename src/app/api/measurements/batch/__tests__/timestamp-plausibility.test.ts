/**
 * `POST /api/measurements/batch` — entry-instant plausibility bound.
 *
 * The single-entry twin has applied `validateEntryInstant` to `measuredAt`
 * since v1.17 W1b; the 500-entry batch path did not, so a future-dated row
 * landed and permanently won "latest reading" on every dashboard while
 * poisoning the rollup buckets and the canonical picker.
 *
 * The past floor deliberately stays at 1900: a historical Apple Health
 * backfill is a legitimate shape on this route. Only the future side is a bug.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findMany: vi.fn(),
      createMany: vi.fn(),
    },
    $transaction: vi.fn(async (fn: unknown) => {
      if (typeof fn === "function") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (fn as any)(prisma as unknown as { measurement: unknown });
      }
    }),
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/jobs/pr-detection", () => ({
  enqueuePrDetection: vi.fn().mockResolvedValue(undefined),
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

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/measurements/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A step entry anchored on an offset from now, so the test never date-bombs. */
function stepEntryAt(externalId: string, startMs: number, endMs = startMs) {
  return {
    hkIdentifier: "HKQuantityTypeIdentifierStepCount",
    value: 1200,
    unit: "count",
    startDate: new Date(startMs).toISOString(),
    endDate: new Date(endMs).toISOString(),
    externalId,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function statusesFor(entries: unknown[]) {
  const res = await POST(makeRequest({ entries }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: {
      entries: Array<{ index: number; status: string; reason?: string }>;
    };
  };
  return body.data.entries;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 60,
    resetAt: Date.now() + 60_000,
  });
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([]);
  vi.mocked(prisma.measurement.createMany).mockResolvedValue({ count: 1 });
});

describe("POST /api/measurements/batch — entry-instant plausibility", () => {
  it("skips a far-future entry instead of persisting it", async () => {
    const results = await statusesFor([
      stepEntryAt("ext-future", Date.now() + 365 * DAY_MS),
    ]);
    expect(results[0]).toMatchObject({
      index: 0,
      status: "skipped",
      reason: "implausible_timestamp",
    });
  });

  it("skips an entry predating the 1900 floor", async () => {
    const results = await statusesFor([
      stepEntryAt("ext-ancient", Date.UTC(1899, 11, 31)),
    ]);
    expect(results[0]).toMatchObject({
      status: "skipped",
      reason: "implausible_timestamp",
    });
  });

  it("accepts a historical backfill entry — the past floor stays at 1900", async () => {
    const results = await statusesFor([
      stepEntryAt("ext-old", Date.now() - 8 * 365 * DAY_MS),
    ]);
    expect(results[0]!.status).not.toBe("skipped");
  });

  it("tolerates a client clock a couple of minutes fast", async () => {
    const results = await statusesFor([
      stepEntryAt("ext-skew", Date.now() + 2 * 60 * 1000),
    ]);
    expect(results[0]!.status).not.toBe("skipped");
  });

  it("skips only the offending entry and keeps the rest of the batch", async () => {
    const results = await statusesFor([
      stepEntryAt("ext-ok", Date.now() - DAY_MS),
      stepEntryAt("ext-bad", Date.now() + 365 * DAY_MS),
    ]);
    expect(results[0]!.status).not.toBe("skipped");
    expect(results[1]).toMatchObject({ reason: "implausible_timestamp" });
  });
});
