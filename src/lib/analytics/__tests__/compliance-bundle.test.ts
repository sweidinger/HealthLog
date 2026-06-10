/**
 * v1.15.20 — single-pass compliance bundle parity.
 *
 * `buildMedicationComplianceBundle` replaces the per-medication compliance
 * route's five-plus expansion passes (calculateCompliance × 4, the window
 * ladder probes, the heatmap mint) with ONE band expansion + ONE cadence
 * timeline. These tests pin the bundle's blocks against the historical
 * per-window composition so the refactor cannot drift the public payload:
 * every block must be deep-equal to what `calculateCompliance` /
 * `buildComplianceDisplay` produce for the same fixture.
 */
import { describe, it, expect } from "vitest";

import {
  buildComplianceMedicationContext,
  buildComplianceLedgerRows,
  buildMedicationComplianceBundle,
  buildComplianceDisplay,
  calculateCompliance,
  lastNonSkippedTakenAt,
  tallyComplianceFromLedger,
  tallyLedgerRows,
  type ComplianceSchedule,
} from "../compliance";

const TZ = "UTC";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Deterministic anchor — keeps every window fully in the fixture's hands. */
const NOW = new Date("2026-06-01T12:00:00Z");

function dailySchedule(): ComplianceSchedule {
  return {
    windowStart: "08:00",
    windowEnd: "09:00",
    timesOfDay: ["08:00"],
    daysOfWeek: null,
    rrule: null,
    rollingIntervalDays: null,
    reminderGraceMinutes: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
  };
}

function rollingSchedule(intervalDays: number): ComplianceSchedule {
  return {
    windowStart: "10:00",
    windowEnd: "11:00",
    timesOfDay: ["10:00"],
    daysOfWeek: null,
    rrule: null,
    rollingIntervalDays: intervalDays,
    reminderGraceMinutes: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
  };
}

/** A slot instant `daysAgo` before NOW at the given "HH:mm" (UTC fixture). */
function slotAt(daysAgo: number, hhmm: string): Date {
  const day = new Date(NOW.getTime() - daysAgo * DAY_MS);
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(day);
  d.setUTCHours(h, m, 0, 0);
  return d;
}

interface FixtureEvent {
  takenAt: Date | null;
  skipped: boolean;
  scheduledFor: Date;
  autoMissed?: boolean;
}

function dailyFixtureEvents(): FixtureEvent[] {
  return [
    // Taken on time across several days.
    { takenAt: slotAt(1, "08:05"), skipped: false, scheduledFor: slotAt(1, "08:00") },
    { takenAt: slotAt(2, "08:10"), skipped: false, scheduledFor: slotAt(2, "08:00") },
    { takenAt: slotAt(4, "07:55"), skipped: false, scheduledFor: slotAt(4, "08:00") },
    // A deliberate skip (excluded from the denominator).
    { takenAt: null, skipped: true, scheduledFor: slotAt(3, "08:00") },
    // A taken-late dose (inside the late tail).
    { takenAt: slotAt(5, "10:30"), skipped: false, scheduledFor: slotAt(5, "08:00") },
    // Day 6 has no event → the unfilled slot reads missed.
    // An auto-missed forgotten dose.
    {
      takenAt: null,
      skipped: false,
      scheduledFor: slotAt(8, "08:00"),
      autoMissed: true,
    },
  ];
}

describe("buildMedicationComplianceBundle — parity with the per-window composition", () => {
  it("daily medication: every block equals the legacy multi-pass output", () => {
    const createdAt = new Date(NOW.getTime() - 40 * DAY_MS);
    const schedules = [dailySchedule()];
    const events = dailyFixtureEvents();
    const ctx = buildComplianceMedicationContext(
      { startsOn: null, endsOn: null, oneShot: false, createdAt },
      lastNonSkippedTakenAt(events),
      TZ,
    );

    const bundle = buildMedicationComplianceBundle(events, schedules, ctx, NOW);

    expect(bundle.compliance7).toEqual(
      calculateCompliance(events, schedules, 7, createdAt, {
        now: NOW,
        medicationContext: ctx,
      }),
    );
    expect(bundle.compliance30).toEqual(
      calculateCompliance(events, schedules, 30, createdAt, {
        now: NOW,
        medicationContext: ctx,
      }),
    );
    expect(bundle.complianceDisplay).toEqual(
      buildComplianceDisplay(events, schedules, ctx, { now: NOW }),
    );

    // The ledger window clamps to the medication's creation.
    expect(bundle.ledgerFrom).toEqual(createdAt);
    // One band per daily slot over the 40-day life → 40 or 41 slot rows
    // (the boundary day depends on the creation instant vs slot time).
    const slotRows = bundle.ledgerRows.filter((r) => r.kind === "slot");
    expect(slotRows.length).toBeGreaterThanOrEqual(39);
    expect(slotRows.length).toBeLessThanOrEqual(41);
  });

  it("rolling 35-day medication: display windows + rates match the legacy path", () => {
    const createdAt = new Date(NOW.getTime() - 400 * DAY_MS);
    const schedules = [rollingSchedule(35)];
    const events: FixtureEvent[] = [
      {
        takenAt: new Date(NOW.getTime() - 25 * DAY_MS),
        skipped: false,
        scheduledFor: new Date(NOW.getTime() - 25 * DAY_MS),
      },
      {
        takenAt: new Date(NOW.getTime() - 60 * DAY_MS),
        skipped: false,
        scheduledFor: new Date(NOW.getTime() - 60 * DAY_MS),
      },
    ];
    const ctx = buildComplianceMedicationContext(
      {
        startsOn: new Date(NOW.getTime() - 380 * DAY_MS),
        endsOn: null,
        oneShot: false,
        createdAt,
      },
      lastNonSkippedTakenAt(events),
      TZ,
    );

    const bundle = buildMedicationComplianceBundle(events, schedules, ctx, NOW);

    expect(bundle.compliance7).toEqual(
      calculateCompliance(events, schedules, 7, createdAt, {
        now: NOW,
        medicationContext: ctx,
      }),
    );
    expect(bundle.compliance30).toEqual(
      calculateCompliance(events, schedules, 30, createdAt, {
        now: NOW,
        medicationContext: ctx,
      }),
    );
    expect(bundle.complianceDisplay).toEqual(
      buildComplianceDisplay(events, schedules, ctx, { now: NOW }),
    );
    // A 35-day cadence cannot clear the stability floor on [7, 30].
    expect(bundle.complianceDisplay.shortDays).toBeGreaterThan(7);
    expect(bundle.complianceDisplay.longDays).toBeGreaterThan(30);
  });

  it("empty schedule list: zeros short-circuit matches calculateCompliance", () => {
    const createdAt = new Date(NOW.getTime() - 10 * DAY_MS);
    const ctx = buildComplianceMedicationContext(
      { startsOn: null, endsOn: null, oneShot: false, createdAt },
      null,
      TZ,
    );

    const bundle = buildMedicationComplianceBundle([], [], ctx, NOW);

    expect(bundle.compliance7).toEqual(
      calculateCompliance([], [], 7, createdAt, {
        now: NOW,
        medicationContext: ctx,
      }),
    );
    expect(bundle.complianceDisplay).toEqual(
      buildComplianceDisplay([], [], ctx, { now: NOW }),
    );
    expect(bundle.ledgerRows).toEqual([]);
  });
});

describe("tallyLedgerRows — windowed tallies over one shared ledger", () => {
  it("the unwindowed tally equals tallyComplianceFromLedger byte-for-byte", () => {
    const createdAt = new Date(NOW.getTime() - 40 * DAY_MS);
    const schedules = [dailySchedule()];
    const events = dailyFixtureEvents();
    const ctx = buildComplianceMedicationContext(
      { startsOn: null, endsOn: null, oneShot: false, createdAt },
      lastNonSkippedTakenAt(events),
      TZ,
    );
    const from = new Date(NOW.getTime() - 30 * DAY_MS);

    const rows = buildComplianceLedgerRows(events, schedules, ctx, from, NOW, NOW);
    expect(tallyLedgerRows(rows)).toEqual(
      tallyComplianceFromLedger(events, schedules, ctx, from, NOW, NOW),
    );
  });

  it("a sub-window tally counts only rows inside the window", () => {
    const createdAt = new Date(NOW.getTime() - 40 * DAY_MS);
    const schedules = [dailySchedule()];
    const events = dailyFixtureEvents();
    const ctx = buildComplianceMedicationContext(
      { startsOn: null, endsOn: null, oneShot: false, createdAt },
      lastNonSkippedTakenAt(events),
      TZ,
    );

    const rows = buildComplianceLedgerRows(
      events,
      schedules,
      ctx,
      createdAt,
      NOW,
      NOW,
    );
    const wide = tallyLedgerRows(rows);
    // 3.5 days reaches back past the day −3 08:00 slot (NOW is 12:00Z, so a
    // plain 3-day bound would cut that morning slot off).
    const narrow = tallyLedgerRows(rows, {
      from: new Date(NOW.getTime() - 3.5 * DAY_MS),
      to: NOW,
    });

    // Days −1 and −2 are taken on time; day −3 is a skip. Everything
    // older falls outside the window.
    expect(narrow.takenOnTime).toBe(2);
    expect(narrow.skipped).toBe(1);
    expect(narrow.denominator).toBeLessThan(wide.denominator);
  });
});
