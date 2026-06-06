/**
 * Prisma-row → engine-input adapters + calendar composition
 * (ios-contract §2.D). The engine itself (`predictCycle`, `phaseSeries`)
 * is pure + DB-free; this module bridges the persisted rows to the plain
 * input shapes and assembles the `CalendarDayDTO` grid the read returns.
 */
import {
  predictCycle,
  phaseForDay,
  addDays,
  dayDiff,
  isWithin,
  type CycleInput,
  type DayLogInput,
  type NightlyTempInput,
  type CycleProfileInput,
  type CyclePredictionResult,
  type CyclePhase,
  type PhaseCycle,
  resolveLuteal,
} from "@/lib/cycle";
import type {
  CycleProfile,
  CycleDayLog,
  MenstrualCycle,
} from "@/generated/prisma/client";

export interface CalendarDayDTO {
  date: string;
  phase: CyclePhase | null;
  isPredictedPeriod: boolean;
  isFertileWindow: boolean;
  isPredictedOvulation: boolean;
  isPeriodLogged: boolean;
  flow: string | null;
  hasSymptoms: boolean;
  confidence: number;
}

/** Rows the calendar needs from each day-log. */
export type CalendarDayLogRow = Pick<
  CycleDayLog,
  "date" | "flow" | "basalBodyTempC" | "ovulationTest" | "cervicalMucus"
> & { hasSymptoms: boolean };

/** Map MenstrualCycle rows (oldest→newest) to engine `CycleInput`. */
export function toCycleInputs(
  cycles: readonly Pick<
    MenstrualCycle,
    "startDate" | "endDate" | "periodEndDate" | "ovulationDate" | "ovulationConfirmed"
  >[],
): CycleInput[] {
  return cycles.map((c) => ({
    startDate: c.startDate,
    endDate: c.endDate,
    periodEndDate: c.periodEndDate,
    ovulationDate: c.ovulationDate,
    ovulationConfirmed: c.ovulationConfirmed,
  }));
}

/** Map CycleDayLog rows to engine `DayLogInput`. */
export function toDayLogInputs(
  logs: readonly Pick<
    CycleDayLog,
    "date" | "flow" | "basalBodyTempC" | "ovulationTest" | "cervicalMucus"
  >[],
): DayLogInput[] {
  return logs.map((l) => ({
    date: l.date,
    flow: l.flow,
    basalBodyTempC: l.basalBodyTempC,
    ovulationTest: l.ovulationTest,
    cervicalMucus: l.cervicalMucus,
  }));
}

/** Map a CycleProfile row to the engine's `CycleProfileInput`. */
export function toProfileInput(profile: CycleProfile): CycleProfileInput {
  return {
    goal: profile.goal,
    typicalCycleLength: profile.typicalCycleLength,
    typicalPeriodLength: profile.typicalPeriodLength,
    lutealPhaseLength: profile.lutealPhaseLength,
    predictionEnabled: profile.predictionEnabled,
    rawChartMode: profile.rawChartMode,
  };
}

/** Period-length of an observed cycle: periodEnd − start + 1, or default. */
function periodLengthOf(
  cycle: Pick<MenstrualCycle, "startDate" | "periodEndDate">,
): number | null {
  if (!cycle.periodEndDate) return null;
  return dayDiff(cycle.periodEndDate, cycle.startDate) + 1;
}

/**
 * Build a contiguous `PhaseCycle[]` from the observed cycles (each cycle's
 * span ends where the next begins; the latest open cycle runs to the
 * predicted next-period start). Used to label every calendar day's phase.
 */
export function buildPhaseCycles(
  cycles: readonly Pick<
    MenstrualCycle,
    "startDate" | "endDate" | "periodEndDate" | "ovulationDate"
  >[],
  predictedNextStart: string | null,
  lutealLength: number,
): PhaseCycle[] {
  const sorted = [...cycles].sort((a, b) => dayDiff(a.startDate, b.startDate));
  const out: PhaseCycle[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const next = sorted[i + 1];
    const nextStart =
      next?.startDate ?? predictedNextStart ?? addDays(c.startDate, 28);
    out.push({
      startDate: c.startDate,
      nextStart,
      ovulationDate: c.ovulationDate,
      periodLength: periodLengthOf(c),
      lutealLength,
    });
  }
  return out;
}

/** Phase of a single date across the contiguous cycle list (or null). */
export function phaseAcross(
  date: string,
  phaseCycles: readonly PhaseCycle[],
): CyclePhase | null {
  for (const pc of phaseCycles) {
    const r = phaseForDay(date, pc);
    if (r.phase !== null) return r.phase;
  }
  return null;
}

/**
 * Resolve the phase + 1-based day-of-cycle of a single `YYYY-MM-DD` date
 * across the observed cycles, with the latest open cycle running to
 * `predictedNextStart` (or +28d). Returns `{ phase: null, dayOfCycle: null }`
 * when the date falls outside every cycle window. Used by the Coach snapshot
 * to state "you are on day N, luteal phase".
 */
export function phaseForDate(
  date: string,
  cycles: readonly Pick<
    MenstrualCycle,
    "startDate" | "endDate" | "periodEndDate" | "ovulationDate"
  >[],
  predictedNextStart: string | null,
  lutealLength: number,
): { phase: CyclePhase | null; dayOfCycle: number | null } {
  const phaseCycles = buildPhaseCycles(cycles, predictedNextStart, lutealLength);
  for (const pc of phaseCycles) {
    const r = phaseForDay(date, pc);
    if (r.phase !== null) return r;
  }
  return { phase: null, dayOfCycle: null };
}

/**
 * Build a `YYYY-MM-DD → CyclePhase` map across `[from, to]` inclusive from the
 * observed cycles. Days that fall outside every cycle window are omitted (no
 * key) rather than carrying a null — a consumer joins on presence. The latest
 * open cycle runs to `predictedNextStart` (or +28d) like `buildCalendar`, so
 * the trailing window is labelled even before the next period is logged.
 *
 * This is the per-day phase series the CYCLE_PHASE correlation channel and the
 * Coach phase block both consume, derived identically to the calendar grid so
 * the phase a day shows in the UI matches the phase the stats engine uses.
 */
export function buildPhaseDayMap(
  cycles: readonly Pick<
    MenstrualCycle,
    "startDate" | "endDate" | "periodEndDate" | "ovulationDate"
  >[],
  predictedNextStart: string | null,
  lutealLength: number,
  from: string,
  to: string,
): Map<string, CyclePhase> {
  const phaseCycles = buildPhaseCycles(cycles, predictedNextStart, lutealLength);
  const out = new Map<string, CyclePhase>();
  const span = dayDiff(to, from);
  for (let i = 0; i <= span; i++) {
    const date = addDays(from, i);
    const phase = phaseAcross(date, phaseCycles);
    if (phase !== null) out.set(date, phase);
  }
  return out;
}

export interface CalendarBuildResult {
  prediction: CyclePredictionResult | null;
  days: CalendarDayDTO[];
}

/**
 * Compose the calendar grid for `[from, to]` inclusive. Runs the engine
 * once for the forward forecast, then labels each day's phase, predicted
 * period bar, fertile window, and logged-flow overlay.
 *
 * Fertile-window fields are caller-gated: pass `goalAllowsFertile=false`
 * (GENERAL_HEALTH / PERIMENOPAUSE) to suppress `isFertileWindow` +
 * `isPredictedOvulation` at the grid level (the prediction's own window
 * fields are nulled upstream by the engine for those goals).
 */
export function buildCalendar(
  profile: CycleProfile,
  cycles: readonly MenstrualCycle[],
  dayLogs: readonly CalendarDayLogRow[],
  nights: readonly NightlyTempInput[],
  from: string,
  to: string,
  today: string,
  goalAllowsFertile: boolean,
): CalendarBuildResult {
  // Clamp identically to the engine's resolveLuteal so the predicted-ovulation
  // dot (engine-clamped) and the OVULATORY phase band (this value) never
  // diverge for an out-of-clamp stored luteal length (QA HIGH).
  const lutealLength = resolveLuteal(profile);

  // Forecast (only when prediction is on + not raw-chart mode).
  let prediction: CyclePredictionResult | null = null;
  if (profile.predictionEnabled && !profile.rawChartMode) {
    prediction = predictCycle(
      toCycleInputs(cycles),
      toDayLogInputs(dayLogs),
      toProfileInput(profile),
      today,
      nights,
    );
  }

  const phaseCycles = buildPhaseCycles(
    cycles,
    prediction?.nextPeriodStart ?? null,
    lutealLength,
  );

  // Forward predicted period bar: [nextPeriodStart, +predictedPeriodLength).
  const predictedPeriodStart = prediction?.nextPeriodStart ?? null;
  const predictedPeriodEnd =
    prediction && predictedPeriodStart
      ? addDays(
          predictedPeriodStart,
          Math.max(0, prediction.predictedPeriodLength - 1),
        )
      : null;

  const logByDate = new Map<string, CalendarDayLogRow>();
  for (const l of dayLogs) logByDate.set(l.date, l);

  const days: CalendarDayDTO[] = [];
  const span = dayDiff(to, from);
  for (let i = 0; i <= span; i++) {
    const date = addDays(from, i);
    const log = logByDate.get(date);

    const isPredictedPeriod =
      predictedPeriodStart !== null &&
      predictedPeriodEnd !== null &&
      isWithin(date, predictedPeriodStart, predictedPeriodEnd);

    const isFertileWindow =
      goalAllowsFertile &&
      prediction?.fertileWindowStart != null &&
      prediction.fertileWindowEnd != null &&
      isWithin(date, prediction.fertileWindowStart, prediction.fertileWindowEnd);

    const isPredictedOvulation =
      goalAllowsFertile &&
      prediction?.predictedOvulation != null &&
      prediction.predictedOvulation === date;

    days.push({
      date,
      phase: phaseAcross(date, phaseCycles),
      isPredictedPeriod,
      isFertileWindow,
      isPredictedOvulation,
      isPeriodLogged:
        log?.flow != null && log.flow !== "NONE",
      flow: log?.flow ?? null,
      hasSymptoms: log?.hasSymptoms ?? false,
      confidence: prediction?.confidence ?? 0,
    });
  }

  return { prediction, days };
}
