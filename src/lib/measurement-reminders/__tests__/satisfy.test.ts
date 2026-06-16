/**
 * v1.18.1 — the shared `satisfyReminder` primitive: forward-only guard +
 * re-anchored reschedule. The cron, the manual satisfy route, and the
 * eventful worker all route through it, so these tests pin the invariants
 * every caller relies on.
 */
import { describe, expect, it, vi } from "vitest";

import { satisfyReminder } from "../satisfy";

const TZ = "Europe/Berlin";

function makePrisma(updateManyCount = 1) {
  const updates: Array<{
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }> = [];
  const prisma = {
    measurementReminder: {
      // v1.18.1 — `satisfyReminder` now writes via a conditional
      // `updateMany` so the forward-only guard re-asserts at the DB row
      // (close the cron-vs-worker TOCTOU). `updateManyCount` simulates a
      // racing writer having already advanced the row (count === 0).
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          if (updateManyCount > 0) updates.push({ where, data });
          return { count: updateManyCount };
        },
      ),
    },
  };
  return { prisma, updates };
}

function reminder(overrides: Partial<Parameters<typeof satisfyReminder>[1]> = {}) {
  return {
    id: "r1",
    intervalDays: 7,
    rrule: null,
    anchorDate: null,
    notifyHour: 9,
    lastSatisfiedAt: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

describe("satisfyReminder", () => {
  it("stamps lastSatisfiedAt + recomputes nextDueAt when never satisfied", async () => {
    const { prisma, updates } = makePrisma();
    const at = new Date("2026-06-14T18:00:00Z");

    const result = await satisfyReminder(
      prisma as never,
      reminder(),
      TZ,
      at,
    );

    expect(result.satisfied).toBe(true);
    expect(result.nextDueAt).toBeInstanceOf(Date);
    expect(updates).toHaveLength(1);
    expect(updates[0].data.lastSatisfiedAt).toEqual(at);
    // Rolling +7d from the satisfy instant — strictly in the future.
    expect((updates[0].data.nextDueAt as Date).getTime()).toBeGreaterThan(
      at.getTime(),
    );
  });

  it("re-asserts the forward-only invariant in the conditional updateMany", async () => {
    const { prisma } = makePrisma();
    const at = new Date("2026-06-14T18:00:00Z");

    await satisfyReminder(prisma as never, reminder(), TZ, at);

    const call = prisma.measurementReminder.updateMany.mock
      .calls[0][0] as unknown as {
      where: { id: string; OR: unknown[] };
    };
    expect(call.where.id).toBe("r1");
    expect(call.where.OR).toEqual([
      { lastSatisfiedAt: null },
      { lastSatisfiedAt: { lt: at } },
    ]);
  });

  it("treats a racing-writer updateMany count of 0 as a forward-only no-op", async () => {
    const { prisma } = makePrisma(0);
    const at = new Date("2026-06-14T18:00:00Z");

    const result = await satisfyReminder(prisma as never, reminder(), TZ, at);

    // The in-memory guard passed (lastSatisfiedAt null) but the DB write
    // matched no row — a concurrent satisfy already advanced it. No-op.
    expect(result.satisfied).toBe(false);
    expect(result.nextDueAt).toBeNull();
  });

  it("advances when the event is strictly after the existing lastSatisfiedAt", async () => {
    const { prisma, updates } = makePrisma();
    const prev = new Date("2026-06-10T08:00:00Z");
    const at = new Date("2026-06-17T08:00:00Z");

    const result = await satisfyReminder(
      prisma as never,
      reminder({ lastSatisfiedAt: prev }),
      TZ,
      at,
    );

    expect(result.satisfied).toBe(true);
    expect(updates[0].data.lastSatisfiedAt).toEqual(at);
  });

  it("is a forward-only no-op when the event is older than lastSatisfiedAt", async () => {
    const { prisma, updates } = makePrisma();
    const prev = new Date("2026-06-17T08:00:00Z");
    const stale = new Date("2026-06-10T08:00:00Z");

    const result = await satisfyReminder(
      prisma as never,
      reminder({ lastSatisfiedAt: prev }),
      TZ,
      stale,
    );

    expect(result.satisfied).toBe(false);
    expect(result.nextDueAt).toBeNull();
    expect(prisma.measurementReminder.updateMany).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("is a no-op when the event equals lastSatisfiedAt (cron behind an applied hook)", async () => {
    const { prisma } = makePrisma();
    const same = new Date("2026-06-17T08:00:00Z");

    const result = await satisfyReminder(
      prisma as never,
      reminder({ lastSatisfiedAt: same }),
      TZ,
      same,
    );

    expect(result.satisfied).toBe(false);
    expect(prisma.measurementReminder.updateMany).not.toHaveBeenCalled();
  });
});
