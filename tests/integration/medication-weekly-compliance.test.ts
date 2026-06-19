/**
 * v1.12.0 — weekly-injectable compliance regression.
 *
 * Reproduces, against a real Postgres row, the live defect where a
 * WEEKLY injectable (Mounjaro / GLP-1) with recorded intakes reported
 * 0% compliance across EVERY window (7 / 30 / 90 days) on the medication
 * card. The web reads the server-computed `compliance7` / `compliance30`
 * / `complianceDisplay` values verbatim, so the server value itself was
 * 0% — not a relabel.
 *
 * Root cause: the intake-to-slot matcher (`pairDoses`) used a fixed ±12h
 * pairing radius. That radius is correct for a daily cadence (24h gap)
 * but far too tight for a once-weekly dose, where a real intake is rarely
 * logged within 12h of the schedule's configured HH:mm — the user takes
 * the shot on whichever day / time of the dosing week suits them. Those
 * intakes fell outside the radius, every weekly slot read `missed`, and
 * the rate collapsed to 0%. The radius now scales with the cadence gap.
 *
 * The test writes a Mounjaro-shaped medication + schedule + intake rows,
 * reads them back through the application Prisma singleton (so the
 * column shapes — `timesOfDay[]`, `rrule`, `daysOfWeek`,
 * `rollingIntervalDays` — are byte-identical to what the route reads),
 * and asserts the cadence-aware compliance helpers return the true
 * non-zero rate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

import {
  buildComplianceDisplay,
  buildComplianceMedicationContext,
  calculateCompliance,
  lastNonSkippedTakenAt,
  type ComplianceSchedule,
} from "@/lib/analytics/compliance";

const TEST_USER_ID = "user-weekly-compliance";
const USER_TZ = "Europe/Berlin";
const DAY_MS = 24 * 60 * 60 * 1000;

// Pin "now" to a Wednesday so a Monday weekly cadence has a clean count
// of Mondays in each trailing window.
const NOW = new Date("2025-06-04T12:00:00Z");

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: {
      id: TEST_USER_ID,
      username: "weekly-compliance",
      email: "weekly-compliance@example.test",
      timezone: USER_TZ,
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Create a weekly Mounjaro-shaped medication. The schedule is encoded the
 * way the create route writes a once-weekly injectable, parameterised so
 * the test can cover both the RRULE-weekly and rolling-interval forms.
 */
async function createWeeklyMounjaro(opts: {
  rrule?: string;
  rollingIntervalDays?: number;
  daysOfWeek?: string | null;
  windowStart: string;
}): Promise<string> {
  const prisma = getPrismaClient();
  const med = await prisma.medication.create({
    data: {
      userId: TEST_USER_ID,
      name: "Mounjaro",
      dose: "5mg",
      treatmentClass: "GLP1",
      deliveryForm: "INJECTION",
      // Created ~100 days ago so the 90-day window is fully covered.
      createdAt: new Date(NOW.getTime() - 100 * DAY_MS),
      startsOn: new Date("2025-02-24T00:00:00Z"), // a Monday
      schedules: {
        create: {
          windowStart: opts.windowStart,
          windowEnd: opts.windowStart,
          timesOfDay: [opts.windowStart],
          daysOfWeek: opts.daysOfWeek ?? null,
          ...(opts.rrule !== undefined && { rrule: opts.rrule }),
          ...(opts.rollingIntervalDays !== undefined && {
            rollingIntervalDays: opts.rollingIntervalDays,
          }),
        },
      },
    },
  });
  return med.id;
}

/**
 * Log `count` weekly intakes on consecutive Mondays back from
 * `lastMonday`, each taken at the given local time-of-day (deliberately
 * NOT the schedule's configured HH:mm, mirroring real usage where the
 * shot is taken whenever).
 */
async function logWeeklyIntakes(
  medicationId: string,
  lastMonday: Date,
  count: number,
): Promise<void> {
  const prisma = getPrismaClient();
  for (let i = 0; i < count; i++) {
    const at = new Date(lastMonday.getTime() - i * 7 * DAY_MS);
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: TEST_USER_ID,
        medicationId,
        scheduledFor: at,
        takenAt: at,
        skipped: false,
      },
    });
  }
}

/**
 * Mirror the compliance route: read the medication + schedules + intakes,
 * build the context, and compute the three windows + the display block.
 */
async function readCompliance(medicationId: string) {
  const prisma = getPrismaClient();
  const medication = await prisma.medication.findUniqueOrThrow({
    where: { id: medicationId },
    include: { schedules: true },
  });
  const events = await prisma.medicationIntakeEvent.findMany({
    where: { medicationId, userId: TEST_USER_ID, deletedAt: null },
    orderBy: { scheduledFor: "desc" },
  });
  const mapped = events.map((e) => ({
    takenAt: e.takenAt,
    skipped: e.skipped,
    scheduledFor: e.scheduledFor,
  }));
  const lastIntakeAt = lastNonSkippedTakenAt(mapped);
  const ctx = buildComplianceMedicationContext(
    medication,
    lastIntakeAt,
    USER_TZ,
  );
  const schedules = medication.schedules as ComplianceSchedule[];
  return {
    compliance7: calculateCompliance(
      mapped,
      schedules,
      7,
      medication.createdAt,
      {
        medicationContext: ctx,
      },
    ),
    compliance30: calculateCompliance(
      mapped,
      schedules,
      30,
      medication.createdAt,
      {
        medicationContext: ctx,
      },
    ),
    compliance90: calculateCompliance(
      mapped,
      schedules,
      90,
      medication.createdAt,
      {
        medicationContext: ctx,
      },
    ),
    display: buildComplianceDisplay(mapped, schedules, ctx),
  };
}

describe("weekly injectable compliance (Mounjaro 0% regression)", () => {
  // Mondays back from the pinned Wednesday, taken at 20:00 local (well
  // outside the schedule's 07:30 HH:mm and the legacy ±12h radius).
  const lastMonday = new Date("2025-06-02T18:00:00Z");

  it("RRULE FREQ=WEEKLY;BYDAY=MO — off-time Monday intakes report the true rate, not 0%", async () => {
    const id = await createWeeklyMounjaro({
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      windowStart: "07:30",
    });
    await logWeeklyIntakes(id, lastMonday, 13);

    const { compliance7, compliance30, compliance90, display } =
      await readCompliance(id);

    // Every recorded weekly dose pairs to its week's slot → 100%.
    expect(compliance7.rate).toBe(100);
    expect(compliance30.rate).toBe(100);
    expect(compliance90.rate).toBe(100);
    // And the denominator is the count of Mondays, not days.
    expect(compliance30.taken).toBeGreaterThan(0);
    expect(compliance90.taken).toBeGreaterThanOrEqual(12);
    expect(compliance90.missed).toBe(0);
    // The two-row card display agrees.
    expect(display.short.rate).toBe(100);
    expect(display.long.rate).toBe(100);
  });

  it("legacy daysOfWeek='1' (Monday-only) — off-time Monday intakes report the true rate, not 0%", async () => {
    const id = await createWeeklyMounjaro({
      daysOfWeek: "1",
      windowStart: "07:30",
    });
    await logWeeklyIntakes(id, lastMonday, 13);

    const { compliance7, compliance30, compliance90 } =
      await readCompliance(id);

    expect(compliance7.rate).toBe(100);
    expect(compliance30.rate).toBe(100);
    expect(compliance90.rate).toBe(100);
    expect(compliance90.missed).toBe(0);
  });

  it("RRULE weekly — one missed week reports a high-but-not-100 rate (matcher still discriminates a real gap)", async () => {
    const id = await createWeeklyMounjaro({
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      windowStart: "07:30",
    });
    // Take the most-recent Monday on time, then skip ONE older Monday
    // (`lastMonday − 7d`, which sits 9 days before the pinned now — past
    // the weekly 4-day overdue tail, so it counts as definitively missed
    // rather than still-takeable) and take the 11 Mondays before it. The
    // gap is a real, settled miss, not a head-of-window overdue slot.
    await logWeeklyIntakes(id, lastMonday, 1);
    await logWeeklyIntakes(
      id,
      new Date(lastMonday.getTime() - 14 * DAY_MS),
      11,
    );

    const { compliance90 } = await readCompliance(id);
    // 12 taken of 13 expected → ~92%, definitively non-zero and below 100.
    expect(compliance90.rate).toBeGreaterThan(80);
    expect(compliance90.rate).toBeLessThan(100);
    expect(compliance90.missed).toBeGreaterThanOrEqual(1);
  });
});
