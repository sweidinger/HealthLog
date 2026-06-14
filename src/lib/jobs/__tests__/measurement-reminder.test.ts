/**
 * v1.17.1 — Vorsorge (measurement) reminder dispatcher unit tests.
 *
 * Pins the contract:
 *   - Due-predicate window: fires only when past-due AND inside the
 *     reminder's local notify-hour (08:59 → no, 09:00 → yes, 09:59 →
 *     yes, 10:00 → no). A disabled reminder / null nextDueAt never fires.
 *   - Auto-resolve: a matching reading of the reminder's measurementType
 *     logged since the last satisfy advances lastSatisfiedAt + recomputes
 *     nextDueAt and suppresses the nudge. Free-text reminders never
 *     auto-resolve.
 *   - Ledger-free dedup: a successful dispatch advances nextDueAt past
 *     now so the same due cycle never re-fires.
 *   - clientManaged suppression skips the APNs send but still advances.
 *
 * The Prisma surface is stubbed manually to avoid a testcontainer boot.
 */
import { describe, it, expect, vi } from "vitest";

import {
  evaluateMeasurementReminderDue,
  runMeasurementReminderTick,
} from "../measurement-reminder";
import type { NotificationPayload } from "@/lib/notifications/types";
import type { DispatchOutcome } from "@/lib/notifications/dispatcher";

type DispatchFn = (payload: NotificationPayload) => Promise<DispatchOutcome>;

const OK: DispatchOutcome = {
  dispatched: true,
  channelsAttempted: 1,
  channelsSucceeded: 1,
};

const TZ = "Europe/Berlin";

// 09:00 Berlin in June = 07:00Z.
const NINE_LOCAL = new Date("2026-06-15T07:00:00Z");

describe("evaluateMeasurementReminderDue — window boundary", () => {
  const reminder = { enabled: true, notifyHour: 9, nextDueAt: new Date(0) };

  it("08:59 local → not in hour window", () => {
    const d = evaluateMeasurementReminderDue(
      reminder,
      TZ,
      new Date("2026-06-15T06:59:00Z"),
    );
    expect(d.isDue).toBe(true);
    expect(d.inHourWindow).toBe(false);
    expect(d.fire).toBe(false);
  });

  it("09:00 local → fires", () => {
    const d = evaluateMeasurementReminderDue(reminder, TZ, NINE_LOCAL);
    expect(d.fire).toBe(true);
  });

  it("09:59 local → still in window", () => {
    const d = evaluateMeasurementReminderDue(
      reminder,
      TZ,
      new Date("2026-06-15T07:59:00Z"),
    );
    expect(d.fire).toBe(true);
  });

  it("10:00 local → outside window", () => {
    const d = evaluateMeasurementReminderDue(
      reminder,
      TZ,
      new Date("2026-06-15T08:00:00Z"),
    );
    expect(d.inHourWindow).toBe(false);
    expect(d.fire).toBe(false);
  });

  it("not yet due → never fires", () => {
    const d = evaluateMeasurementReminderDue(
      { enabled: true, notifyHour: 9, nextDueAt: new Date("2099-01-01") },
      TZ,
      NINE_LOCAL,
    );
    expect(d.isDue).toBe(false);
    expect(d.fire).toBe(false);
  });

  it("disabled / null nextDueAt → never fires", () => {
    expect(
      evaluateMeasurementReminderDue(
        { enabled: false, notifyHour: 9, nextDueAt: new Date(0) },
        TZ,
        NINE_LOCAL,
      ).fire,
    ).toBe(false);
    expect(
      evaluateMeasurementReminderDue(
        { enabled: true, notifyHour: 9, nextDueAt: null },
        TZ,
        NINE_LOCAL,
      ).fire,
    ).toBe(false);
  });
});

interface FakeReminder {
  id: string;
  measurementType: string | null;
  intervalDays: number | null;
  rrule: string | null;
  anchorDate: Date | null;
  notifyHour: number;
  location: string | null;
  nextDueAt: Date | null;
  lastSatisfiedAt: Date | null;
  enabled: boolean;
  createdAt: Date;
  user: {
    id: string;
    timezone: string;
    locale: string | null;
    notificationPrefs: unknown;
  };
}

function makePrisma(opts: {
  reminders: FakeReminder[];
  measurementMatch?: { measuredAt: Date } | null;
}) {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const prisma = {
    measurementReminder: {
      findMany: vi.fn(async () => opts.reminders),
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
    measurement: {
      findFirst: vi.fn(async () => opts.measurementMatch ?? null),
    },
  };
  return { prisma, updates };
}

function reminder(overrides: Partial<FakeReminder>): FakeReminder {
  return {
    id: "r1",
    measurementType: "BLOOD_PRESSURE_SYS",
    intervalDays: 7,
    rrule: null,
    anchorDate: null,
    notifyHour: 9,
    location: null,
    nextDueAt: new Date("2026-06-14T07:00:00Z"), // past at NINE_LOCAL
    lastSatisfiedAt: null,
    enabled: true,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    user: {
      id: "u1",
      timezone: TZ,
      locale: "de",
      notificationPrefs: null,
    },
    ...overrides,
  };
}

describe("runMeasurementReminderTick", () => {
  it("auto-resolves a typed reminder when a matching reading landed", async () => {
    const matchAt = new Date("2026-06-14T18:00:00Z");
    const { prisma, updates } = makePrisma({
      reminders: [reminder({})],
      measurementMatch: { measuredAt: matchAt },
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    const summary = await runMeasurementReminderTick(
      prisma as never,
      NINE_LOCAL,
      { dispatch },
    );

    expect(summary.autoResolved).toBe(1);
    expect(summary.dispatched).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
    // Advanced lastSatisfiedAt to the reading instant + recomputed nextDueAt.
    expect(updates).toHaveLength(1);
    expect(updates[0].data.lastSatisfiedAt).toEqual(matchAt);
    expect(updates[0].data.nextDueAt).toBeInstanceOf(Date);
  });

  it("dispatches a due reminder and advances nextDueAt past now (ledger-free dedup)", async () => {
    const { prisma, updates } = makePrisma({
      reminders: [reminder({})],
      measurementMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    const summary = await runMeasurementReminderTick(
      prisma as never,
      NINE_LOCAL,
      { dispatch },
    );

    expect(summary.dispatched).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].eventType).toBe("MEASUREMENT_REMINDER");
    // nextDueAt advanced strictly past now.
    expect(updates).toHaveLength(1);
    const advanced = updates[0].data.nextDueAt as Date;
    expect(advanced.getTime()).toBeGreaterThan(NINE_LOCAL.getTime());
  });

  it("free-text reminder never auto-resolves (no measurement query match path)", async () => {
    const { prisma } = makePrisma({
      reminders: [reminder({ measurementType: null })],
      // Even if a reading existed, a free-text reminder must not query it.
      measurementMatch: { measuredAt: new Date("2026-06-14T18:00:00Z") },
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    const summary = await runMeasurementReminderTick(
      prisma as never,
      NINE_LOCAL,
      { dispatch },
    );

    expect(summary.autoResolved).toBe(0);
    expect(summary.dispatched).toBe(1);
    expect(prisma.measurement.findFirst).not.toHaveBeenCalled();
  });

  it("suppresses the push under clientManaged but still advances nextDueAt", async () => {
    const { prisma, updates } = makePrisma({
      reminders: [
        reminder({
          measurementType: null,
          user: {
            id: "u1",
            timezone: TZ,
            locale: "de",
            notificationPrefs: { measurementReminder: { clientManaged: true } },
          },
        }),
      ],
      measurementMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    const summary = await runMeasurementReminderTick(
      prisma as never,
      NINE_LOCAL,
      { dispatch },
    );

    expect(summary.skippedClientManaged).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(updates[0].data.nextDueAt).toBeInstanceOf(Date);
  });

  it("skips a reminder outside its notify-hour window", async () => {
    const { prisma } = makePrisma({
      reminders: [reminder({ measurementType: null })],
      measurementMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    const summary = await runMeasurementReminderTick(
      prisma as never,
      new Date("2026-06-15T08:00:00Z"), // 10:00 Berlin — outside the 09 window
      { dispatch },
    );

    expect(summary.skippedOutsideWindow).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
