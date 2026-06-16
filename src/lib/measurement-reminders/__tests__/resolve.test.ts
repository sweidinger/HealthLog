/**
 * v1.18.1 — `findSatisfyingEvent`: the shared "did a satisfying event
 * land?" matcher. A typed reminder resolves from a Measurement; a
 * free-text reminder resolves from a LabResult (the Lab↔Vorsorge link, D2).
 */
import { describe, expect, it, vi } from "vitest";

import { findSatisfyingEvent, satisfactionFloor } from "../resolve";

type FindFirstArgs = { where: Record<string, unknown> };

function makePrisma(opts: {
  measurement?: { measuredAt: Date } | null;
  lab?: { takenAt: Date } | null;
}) {
  return {
    measurement: {
      findFirst: vi.fn((args: FindFirstArgs) => {
        void args;
        return Promise.resolve(opts.measurement ?? null);
      }),
    },
    labResult: {
      findFirst: vi.fn((args: FindFirstArgs) => {
        void args;
        return Promise.resolve(opts.lab ?? null);
      }),
    },
  };
}

const base = {
  measurementType: null,
  anchorDate: null,
  lastSatisfiedAt: null,
  createdAt: new Date("2026-06-01T00:00:00Z"),
} as const;

describe("satisfactionFloor", () => {
  it("prefers lastSatisfiedAt, then anchorDate, then createdAt", () => {
    const last = new Date("2026-06-10T00:00:00Z");
    const anchor = new Date("2026-06-05T00:00:00Z");
    expect(
      satisfactionFloor({ ...base, lastSatisfiedAt: last, anchorDate: anchor }),
    ).toEqual(last);
    expect(satisfactionFloor({ ...base, anchorDate: anchor })).toEqual(anchor);
    expect(satisfactionFloor(base)).toEqual(base.createdAt);
  });
});

describe("findSatisfyingEvent", () => {
  it("resolves a typed reminder from a matching Measurement, not a lab", async () => {
    const measuredAt = new Date("2026-06-14T18:00:00Z");
    const prisma = makePrisma({ measurement: { measuredAt }, lab: { takenAt: new Date() } });

    const at = await findSatisfyingEvent(prisma as never, "u1", {
      ...base,
      measurementType: "WEIGHT",
    });

    expect(at).toEqual(measuredAt);
    expect(prisma.measurement.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.labResult.findFirst).not.toHaveBeenCalled();
    // Queries the right type, non-deleted, after the floor.
    const where = prisma.measurement.findFirst.mock.calls[0]![0].where as {
      type: string;
      deletedAt: null;
      measuredAt: { gt: Date };
    };
    expect(where.type).toBe("WEIGHT");
    expect(where.deletedAt).toBeNull();
    expect(where.measuredAt.gt).toEqual(base.createdAt);
  });

  it("returns null for a typed reminder with no matching reading", async () => {
    const prisma = makePrisma({ measurement: null });
    const at = await findSatisfyingEvent(prisma as never, "u1", {
      ...base,
      measurementType: "BLOOD_PRESSURE_SYS",
    });
    expect(at).toBeNull();
  });

  it("resolves a free-text reminder from any LabResult (D2)", async () => {
    const takenAt = new Date("2026-06-15T09:00:00Z");
    const prisma = makePrisma({ lab: { takenAt } });

    const at = await findSatisfyingEvent(prisma as never, "u1", {
      ...base,
      measurementType: null,
    });

    expect(at).toEqual(takenAt);
    expect(prisma.labResult.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.measurement.findFirst).not.toHaveBeenCalled();
    const where = prisma.labResult.findFirst.mock.calls[0]![0].where as {
      deletedAt: null;
      takenAt: { gt: Date };
    };
    expect(where.deletedAt).toBeNull();
    expect(where.takenAt.gt).toEqual(base.createdAt);
  });

  it("returns null for a free-text reminder with no lab landed", async () => {
    const prisma = makePrisma({ lab: null });
    const at = await findSatisfyingEvent(prisma as never, "u1", {
      ...base,
      measurementType: null,
    });
    expect(at).toBeNull();
  });
});
