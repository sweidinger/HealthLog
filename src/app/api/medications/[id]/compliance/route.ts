import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, apiError } from "@/lib/api-response";
import {
  buildComplianceDisplay,
  buildComplianceMedicationContext,
  calculateCompliance,
  lastNonSkippedTakenAt,
} from "@/lib/analytics/compliance";
import type { DailyComplianceEntry } from "@/lib/analytics/compliance";
import type { SlotBand } from "@/lib/medications/scheduling/attribution";
import {
  buildBandsForSchedules,
  type BandMinterMedication,
} from "@/lib/medications/scheduling/band-minter";
import {
  reconstructDoseHistory,
  type DoseHistoryRow,
  type HistoryIntake,
} from "@/lib/medications/scheduling/dose-history";
import {
  type CanonicalSchedule,
  type RecurrenceContext,
} from "@/lib/medications/scheduling/recurrence";
import { normaliseDoseWindows } from "@/lib/medications/scheduling/worker-helpers";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { userDayKey } from "@/lib/tz/format";

type RouteParams = { params: Promise<{ id: string }> };

type MedicationScheduleRow = {
  id: string;
  rrule: string | null;
  rollingIntervalDays: number | null;
  timesOfDay: string[];
  daysOfWeek: string | null;
  windowStart: string;
  windowEnd: string;
  reminderGraceMinutes: number | null;
  scheduleType: "SCHEDULED" | "PRN" | "CYCLIC";
  cyclicOnWeeks: number | null;
  cyclicOffWeeks: number | null;
  /** v1.15.18 — per-dose configurable on-time windows (persisted JSON). */
  doseWindows: unknown;
};

/**
 * v1.15.18 — adapt a Prisma schedule row to the canonical engine shape the
 * band minter consumes. A legacy daily row carrying only `windowStart`
 * surfaces it as the single `timeOfDay` so the minter mints its daily band.
 */
function toCanonicalForBands(
  s: MedicationScheduleRow,
  oneShot: boolean,
): CanonicalSchedule {
  const base: CanonicalSchedule = {
    id: s.id,
    rrule: s.rrule,
    rollingIntervalDays: s.rollingIntervalDays,
    timesOfDay: s.timesOfDay,
    daysOfWeek: s.daysOfWeek,
    windowStart: s.windowStart,
    windowEnd: s.windowEnd,
    reminderGraceMinutes: s.reminderGraceMinutes,
    scheduleType: s.scheduleType,
    cyclicOnWeeks: s.cyclicOnWeeks,
    cyclicOffWeeks: s.cyclicOffWeeks,
    doseWindows: normaliseDoseWindows(s.doseWindows),
  };
  if (
    base.timesOfDay.length === 0 &&
    base.rrule === null &&
    base.rollingIntervalDays === null &&
    base.scheduleType !== "PRN" &&
    !oneShot
  ) {
    return { ...base, timesOfDay: [base.windowStart] };
  }
  return base;
}

/**
 * v1.15.18 — fold one dose-history ledger row into a per-day heatmap entry.
 *
 * Slot rows contribute to `expected` / `expectedCount` (the day's due-slot
 * count): a taken slot adds to `taken` and its timing bucket; a missed slot
 * stays uncounted in `taken`; a skipped slot lands in `skipped`; an upcoming
 * slot is still due but not yet acted on. An ad-hoc row is a real off-schedule
 * take — it counts as `taken` AND adds its own `expected` slot (so the
 * heatmap's `missed = expected − taken − skipped` math stays non-negative) and
 * reads on-time (a logged dose colours green).
 */
function bucketLedgerRow(
  entry: DailyComplianceEntry,
  row: DoseHistoryRow,
): void {
  switch (row.status) {
    case "taken_on_time":
      entry.expected++;
      entry.expectedCount++;
      entry.taken++;
      entry.onTime++;
      break;
    case "taken_late":
      entry.expected++;
      entry.expectedCount++;
      entry.taken++;
      entry.late++;
      break;
    case "missed":
      entry.expected++;
      entry.expectedCount++;
      break;
    case "skipped":
      entry.expected++;
      entry.expectedCount++;
      entry.skipped++;
      break;
    case "upcoming":
      // A future / still-takeable slot is due but not yet acted on. It counts
      // toward the day's expected/due grid but not toward taken or missed.
      entry.expected++;
      entry.expectedCount++;
      break;
    case "ad_hoc":
      // An off-schedule take: a real taken dose with no scheduled slot. Count
      // it as taken + its own expected slot so the heatmap missed math holds.
      entry.expected++;
      entry.expectedCount++;
      entry.taken++;
      entry.onTime++;
      break;
  }
}

export const GET = apiHandler(
  async (_request: Request, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    // v1.4.25 W21 Fix-N — privacy gate hoisted to the shared helper.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const medication = await prisma.medication.findUnique({
      where: { id },
      include: { schedules: true },
    });

    if (!medication) {
      return apiError("Medication not found", 404);
    }

    const events = await prisma.medicationIntakeEvent.findMany({
      // v1.7.0 sync — exclude tombstoned rows from the compliance read.
      where: { medicationId: id, userId: user.id, deletedAt: null },
      orderBy: { scheduledFor: "desc" },
    });

    const mapped = events.map((e) => ({
      takenAt: e.takenAt,
      skipped: e.skipped,
      scheduledFor: e.scheduledFor,
      // v1.15.9 — a forgotten dose the auto-miss cron flipped counts as a
      // miss, not a neutral skip.
      autoMissed: e.autoMissed,
    }));

    const createdAt = medication.createdAt;

    // v1.7.0 SB-SCHED-2 — thread the medication context so the
    // denominator routes through the canonical engine (RRULE / rolling /
    // one-shot / PRN / cyclic) instead of the legacy daysOfWeek walker.
    // `lastIntakeAt` is the latest non-skipped takenAt (rolling cadences
    // re-anchor on it); the events list is already ordered scheduledFor
    // desc, so scan for the max takenAt.
    const lastIntakeAt = lastNonSkippedTakenAt(mapped);
    const userTz = user.timezone || "Europe/Berlin";
    const medicationContext = buildComplianceMedicationContext(
      medication,
      lastIntakeAt,
      userTz,
    );

    // v1.15.9 — pin a single `now` and thread it into every cadence
    // computation. The two `calculateCompliance` calls + the display windows
    // can otherwise straddle a day boundary on a slow request, so a dose
    // would count in one window and not the next within the same response.
    const now = new Date();

    const compliance7 = calculateCompliance(mapped, medication.schedules, 7, createdAt, {
      now,
      medicationContext,
    });
    const compliance30 = calculateCompliance(
      mapped,
      medication.schedules,
      30,
      createdAt,
      { now, medicationContext },
    );

    // v1.8.6 — the two-row compliance display. The card always shows two
    // percentage rows; the server scales the two windows to the dosing
    // cadence (dense meds keep 7 / 30 days, sparse meds step both windows
    // up) and computes each row's rate over the chosen span. `compliance7`
    // / `compliance30` above are untouched — iOS + the Health Score read
    // them verbatim.
    const complianceDisplay = buildComplianceDisplay(
      mapped,
      medication.schedules,
      medicationContext,
      { now },
    );

    // v1.15.18 — the heatmap / line-chart daily map is now bucketed from the
    // ONE unified dose-history ledger (the same bands the % + the history view
    // read), so the per-day timing split (on-time / late) and the per-day
    // missed marks can never disagree with the headline rate. The legacy
    // per-day `classifyIntakeTiming` 3h-grace heuristic + `expectedSlotCount
    // ForDay` walk are retired here in favour of band membership: a take inside
    // a slot's on-time band reads on-time, inside its late tail reads late,
    // outside every band reads ad-hoc; an unfilled slot past its miss cutoff
    // reads missed; a future slot is upcoming (not yet due).
    const dailyCompliance: Record<string, DailyComplianceEntry> = {};

    // Build the bands across the whole 90-day heatmap window once. The window
    // floor clamps to the medication's creation so pre-existence days never
    // mint phantom slots.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const windowFrom = new Date(
      Math.max(now.getTime() - 90 * DAY_MS, createdAt.getTime()),
    );
    const bandMedication: BandMinterMedication = {
      id: medication.id,
      startsOn: medication.startsOn,
      endsOn: medication.endsOn,
      oneShot: medication.oneShot,
      createdAt: medication.createdAt,
    };
    const bandCtx: RecurrenceContext = {
      medication: {
        id: medication.id,
        startsOn: medication.startsOn,
        endsOn: medication.endsOn,
        oneShot: medication.oneShot,
        createdAt: medication.createdAt,
      },
      timeZone: userTz,
      lastIntakeAt,
    };
    const canonicalSchedules: CanonicalSchedule[] = medication.schedules.map(
      (s) => toCanonicalForBands(s, medication.oneShot),
    );
    const intakeInstants = mapped
      .filter((e) => !e.skipped && e.takenAt !== null && e.takenAt <= now)
      .map((e) => e.takenAt as Date)
      .sort((a, b) => a.getTime() - b.getTime());
    const groups = buildBandsForSchedules({
      medication: bandMedication,
      schedules: canonicalSchedules,
      ctx: bandCtx,
      userTz,
      range: { from: windowFrom, to: now },
      now,
      intakeInstants,
    });
    const bands: SlotBand[] = [];
    for (const g of groups) {
      if (g.hasExpectedSlots) bands.push(...g.bands);
    }
    const historyIntakes: HistoryIntake[] = mapped
      .filter((e) => e.scheduledFor >= windowFrom && e.scheduledFor <= now)
      .map((e) => ({
        scheduledFor: e.scheduledFor,
        takenAt: e.takenAt,
        skipped: e.skipped,
        autoMissed: e.autoMissed,
      }));
    const ledgerRows = reconstructDoseHistory(bands, historyIntakes, now);

    // Bucket each ledger row into its user-tz day. A slot row buckets on its
    // anchor; an ad-hoc row on its real take time.
    const byDay = new Map<string, DailyComplianceEntry>();
    const ensureDay = (key: string): DailyComplianceEntry => {
      let entry = byDay.get(key);
      if (!entry) {
        entry = {
          expected: 0,
          expectedCount: 0,
          due: false,
          taken: 0,
          skipped: 0,
          onTime: 0,
          late: 0,
          veryLate: 0,
          early: 0,
        };
        byDay.set(key, entry);
      }
      return entry;
    };

    for (const row of ledgerRows) {
      const key = userDayKey(row.at, userTz);
      const entry = ensureDay(key);
      bucketLedgerRow(entry, row);
    }

    for (const [key, entry] of byDay) {
      entry.due = entry.expectedCount > 0;
      dailyCompliance[key] = entry;
    }

    annotate({
      action: {
        name: "medication.compliance",
        entity_type: "medication",
        entity_id: id,
      },
      meta: {
        compliance7: compliance7.rate,
        compliance30: compliance30.rate,
        complianceShortDays: complianceDisplay.shortDays,
        complianceLongDays: complianceDisplay.longDays,
      },
    });

    return apiSuccess({
      compliance7,
      compliance30,
      dailyCompliance,
      complianceDisplay,
    });
  },
);
