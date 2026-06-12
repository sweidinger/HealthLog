/**
 * v1.16.11 — medication low-stock engine: runway-threshold boundary,
 * once-per-crossing dedupe, re-arm on refill / threshold change, the
 * OFF state, and the schedule-less (no runway derivable) case. Pure
 * helpers are pinned without a DB; the tick runs against a prisma
 * mock. Fixtures use relative PAST instants only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  buildLowStockPayload,
  decideLowStockAction,
  evaluateMedicationRunway,
  runMedicationLowStockTick,
} from "../medication-low-stock";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const now = new Date(Date.now() - 60_000);
const daysAgo = (n: number) => new Date(now.getTime() - n * MS_PER_DAY);

/** One dose per day — `timesOfDay` carries a single entry. */
const dailySchedule = {
  windowStart: "08:00",
  daysOfWeek: null,
  timesOfDay: ["08:00"],
  rrule: null,
  rollingIntervalDays: null,
};

/** Weekly GLP-1 cadence — the special case rides the general math. */
const weeklySchedule = {
  windowStart: "08:00",
  daysOfWeek: "6",
  timesOfDay: ["08:00"],
  rrule: null,
  rollingIntervalDays: null,
};

function item(unitsRemaining: number, state = "ACTIVE" as const) {
  return { state, unitsTotal: 30, unitsRemaining };
}

describe("evaluateMedicationRunway", () => {
  it("derives the runway from available units ÷ daily consumption", () => {
    const out = evaluateMedicationRunway([item(6)], 1, [dailySchedule]);
    expect(out).toEqual({
      runwayDays: 6,
      dosesRemaining: 6,
      unitsRemaining: 6,
    });
  });

  it("treats a weekly GLP-1 cadence through the same math (4 doses ≈ 28 days)", () => {
    const out = evaluateMedicationRunway([item(4)], 1, [weeklySchedule]);
    expect(out.runwayDays).toBe(28);
  });

  it("honours unitsPerDose and pools only available containers", () => {
    // 2 units per dose, 4 usable + 10 expired units → 2 doses.
    const out = evaluateMedicationRunway(
      [item(4), { state: "EXPIRED", unitsTotal: 30, unitsRemaining: 10 }],
      2,
      [dailySchedule],
    );
    expect(out.dosesRemaining).toBe(2);
    expect(out.runwayDays).toBe(2);
  });

  it("returns runway 0 for an exhausted supply with a consuming schedule", () => {
    const out = evaluateMedicationRunway([item(0)], 1, [dailySchedule]);
    expect(out.runwayDays).toBe(0);
  });

  it("derives NO runway for a schedule-less medication", () => {
    expect(evaluateMedicationRunway([item(2)], 1, []).runwayDays).toBe(null);
  });
});

describe("decideLowStockAction — boundary / dedupe / re-arm", () => {
  const armed = { notifiedAt: null, notifiedThresholdDays: null };

  it("notifies just below the threshold", () => {
    expect(
      decideLowStockAction({ runwayDays: 6, thresholdDays: 7, ...armed }),
    ).toBe("notify");
  });

  it("stays silent AT the threshold (strictly-below contract)", () => {
    expect(
      decideLowStockAction({ runwayDays: 7, thresholdDays: 7, ...armed }),
    ).toBe("skip_above_threshold");
  });

  it("stays silent above the threshold", () => {
    expect(
      decideLowStockAction({ runwayDays: 8, thresholdDays: 7, ...armed }),
    ).toBe("skip_above_threshold");
  });

  it("does not repeat while still low (stamped crossing)", () => {
    expect(
      decideLowStockAction({
        runwayDays: 5,
        thresholdDays: 7,
        notifiedAt: daysAgo(1),
        notifiedThresholdDays: 7,
      }),
    ).toBe("skip_already_notified");
  });

  it("re-arms when the runway rises back above the threshold (refill)", () => {
    expect(
      decideLowStockAction({
        runwayDays: 30,
        thresholdDays: 7,
        notifiedAt: daysAgo(2),
        notifiedThresholdDays: 7,
      }),
    ).toBe("rearm");
  });

  it("a changed threshold re-arms even while the runway stays low", () => {
    expect(
      decideLowStockAction({
        runwayDays: 10,
        thresholdDays: 14,
        notifiedAt: daysAgo(3),
        notifiedThresholdDays: 7,
      }),
    ).toBe("notify");
  });

  it("never notifies when no runway is derivable", () => {
    expect(
      decideLowStockAction({ runwayDays: null, thresholdDays: 7, ...armed }),
    ).toBe("skip_no_runway");
  });
});

describe("buildLowStockPayload", () => {
  it("names the medication and the remaining days / units (en)", () => {
    const out = buildLowStockPayload("en", "Metformin", 5, 10);
    expect(out.title).toContain("Metformin");
    expect(out.body).toContain("Metformin");
    expect(out.body).toContain("5");
    expect(out.body).toContain("10");
  });

  it("uses the du-Form German copy", () => {
    const out = buildLowStockPayload("de", "Metformin", 5, 10);
    expect(out.body).toContain("Dein Vorrat an Metformin");
    expect(out.body).toContain("5");
  });

  it("switches to the depleted line at runway 0", () => {
    const out = buildLowStockPayload("en", "Metformin", 0, 1);
    expect(out.body).toContain("less than one day");
  });

  it("falls back to the app default locale for unknown locales", () => {
    const out = buildLowStockPayload("xx", "Metformin", 5, 10);
    expect(out.title).toBe("Low supply: Metformin");
  });
});

describe("runMedicationLowStockTick", () => {
  function medRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "med-1",
      name: "Metformin",
      unitsPerDose: 1,
      lowStockNotifiedAt: null,
      lowStockNotifiedThresholdDays: null,
      inventoryItems: [item(5)],
      schedules: [dailySchedule],
      ...overrides,
    };
  }

  function prismaMock(overrides: {
    users?: unknown[];
    medications?: unknown[];
  }) {
    return {
      user: {
        findMany: vi.fn(async () => overrides.users ?? []),
      },
      medication: {
        findMany: vi.fn(async () => overrides.medications ?? []),
        update: vi.fn(async () => ({})),
      },
    };
  }

  const userRow = (notificationPrefs: unknown = null) => ({
    id: "user-1",
    locale: "en",
    notificationPrefs,
  });

  const okDispatch = () =>
    vi.fn<
      (payload: unknown) => Promise<{
        dispatched: boolean;
        channelsAttempted: number;
        channelsSucceeded: number;
      }>
    >(async () => ({
      dispatched: true,
      channelsAttempted: 1,
      channelsSucceeded: 1,
    }));

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("notifies a below-threshold medication and stamps the crossing", async () => {
    const dispatch = okDispatch();
    const prisma = prismaMock({
      users: [userRow()],
      medications: [medRow()],
    });

    const summary = await runMedicationLowStockTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch },
    );

    expect(summary.notified).toBe(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "MEDICATION_LOW_STOCK",
        userId: "user-1",
        metadata: expect.objectContaining({
          medicationId: "med-1",
          runwayDays: 5,
          thresholdDays: 7,
          unitsRemaining: 5,
          // Deep link lands on the detail page's Bestand (supply) tab.
          url: "/medications/med-1?tab=bestand",
        }),
      }),
    );
    expect(prisma.medication.update).toHaveBeenCalledWith({
      where: { id: "med-1" },
      data: {
        lowStockNotifiedAt: now,
        lowStockNotifiedThresholdDays: 7,
      },
    });
  });

  it("does not repeat while still low (stamp present for this threshold)", async () => {
    const dispatch = okDispatch();
    const prisma = prismaMock({
      users: [userRow()],
      medications: [
        medRow({
          lowStockNotifiedAt: daysAgo(1),
          lowStockNotifiedThresholdDays: 7,
        }),
      ],
    });

    const summary = await runMedicationLowStockTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch },
    );

    expect(summary.skippedAlreadyNotified).toBe(1);
    expect(summary.notified).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
    expect(prisma.medication.update).not.toHaveBeenCalled();
  });

  it("re-arms after a refill, then notifies again on the next crossing", async () => {
    const dispatch = okDispatch();
    const stamped = {
      lowStockNotifiedAt: daysAgo(2),
      lowStockNotifiedThresholdDays: 7,
    };
    // Tick 1 — refilled (30 units, runway 30 ≥ 7): the stamp clears.
    const prismaRefilled = prismaMock({
      users: [userRow()],
      medications: [medRow({ ...stamped, inventoryItems: [item(30)] })],
    });
    const refillSummary = await runMedicationLowStockTick(
      prismaRefilled as unknown as PrismaClient,
      now,
      { dispatch },
    );
    expect(refillSummary.rearmed).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(prismaRefilled.medication.update).toHaveBeenCalledWith({
      where: { id: "med-1" },
      data: { lowStockNotifiedAt: null, lowStockNotifiedThresholdDays: null },
    });

    // Tick 2 — consumed back below the threshold with a cleared stamp:
    // the next crossing notifies again.
    const prismaLow = prismaMock({
      users: [userRow()],
      medications: [medRow({ inventoryItems: [item(3)] })],
    });
    const lowSummary = await runMedicationLowStockTick(
      prismaLow as unknown as PrismaClient,
      now,
      { dispatch },
    );
    expect(lowSummary.notified).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("a changed threshold re-arms a still-low stamped medication", async () => {
    const dispatch = okDispatch();
    const prisma = prismaMock({
      users: [userRow({ medication: { lowStockRunwayDays: 14 } })],
      medications: [
        medRow({
          inventoryItems: [item(10)],
          lowStockNotifiedAt: daysAgo(3),
          lowStockNotifiedThresholdDays: 7,
        }),
      ],
    });

    const summary = await runMedicationLowStockTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch },
    );

    expect(summary.notified).toBe(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ thresholdDays: 14 }),
      }),
    );
  });

  it("threshold OFF (null) skips the user without reading medications", async () => {
    const dispatch = okDispatch();
    const prisma = prismaMock({
      users: [userRow({ medication: { lowStockRunwayDays: null } })],
      medications: [medRow()],
    });

    const summary = await runMedicationLowStockTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch },
    );

    expect(summary.skippedThresholdOff).toBe(1);
    expect(prisma.medication.findMany).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("a schedule-less medication never notifies (no runway derivable)", async () => {
    const dispatch = okDispatch();
    const prisma = prismaMock({
      users: [userRow()],
      medications: [medRow({ schedules: [], inventoryItems: [item(1)] })],
    });

    const summary = await runMedicationLowStockTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch },
    );

    expect(summary.skippedNoRunway).toBe(1);
    expect(summary.notified).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
    expect(prisma.medication.update).not.toHaveBeenCalled();
  });

  it("an exhausted supply (runway 0) notifies with the depleted copy", async () => {
    const dispatch = okDispatch();
    const prisma = prismaMock({
      users: [userRow()],
      medications: [medRow({ inventoryItems: [item(0)] })],
    });

    const summary = await runMedicationLowStockTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch },
    );

    expect(summary.notified).toBe(1);
    const payload = dispatch.mock.calls[0]?.[0] as unknown as {
      message: string;
    };
    expect(payload.message).toContain("less than one day");
  });

  it("leaves the stamp clear when no channel succeeded (retry tomorrow)", async () => {
    const dispatch = vi.fn<
      (payload: unknown) => Promise<{
        dispatched: boolean;
        channelsAttempted: number;
        channelsSucceeded: number;
      }>
    >(async () => ({
      dispatched: false,
      channelsAttempted: 0,
      channelsSucceeded: 0,
    }));
    const prisma = prismaMock({
      users: [userRow()],
      medications: [medRow()],
    });

    const summary = await runMedicationLowStockTick(
      prisma as unknown as PrismaClient,
      now,
      { dispatch },
    );

    expect(summary.skippedNoChannel).toBe(1);
    expect(summary.notified).toBe(0);
    expect(prisma.medication.update).not.toHaveBeenCalled();
  });
});
