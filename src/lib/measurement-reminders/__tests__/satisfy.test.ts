/**
 * v1.18.1 — the shared `satisfyReminder` primitive: forward-only guard +
 * re-anchored reschedule. The cron, the manual satisfy route, and the
 * eventful worker all route through it, so these tests pin the invariants
 * every caller relies on.
 */
import { describe, expect, it, vi } from "vitest";

import { satisfyReminder } from "../satisfy";

const TZ = "Europe/Berlin";

function makePrisma() {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const prisma = {
    measurementReminder: {
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          updates.push({ id: where.id, data });
          return { id: where.id, ...data };
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
    expect(prisma.measurementReminder.update).not.toHaveBeenCalled();
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
    expect(prisma.measurementReminder.update).not.toHaveBeenCalled();
  });
});
