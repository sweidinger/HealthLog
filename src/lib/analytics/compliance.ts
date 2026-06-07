/**
 * Medication compliance calculations.
 *
 * v1.5.0 — `calculateCompliance` is now a cadence-aware adapter on top
 * of `complianceChips` / `buildCadenceTimeline`. Prior to this release
 * the helper computed `totalExpected = schedules.length * days`, which
 * silently ignored `MedicationSchedule.daysOfWeek` and `intervalWeeks`.
 * A weekly Ozempic schedule (Mondays only) reported ~13% adherence
 * instead of 100%; a weekday-only 3×/day metformin reported 73%
 * instead of 100%. The wire shape (`{ totalExpected, taken, skipped,
 * missed, rate, streak }`) is unchanged so every consumer (Health
 * Score, AI Coach prompt context, /api/medications/[id]/compliance,
 * BP-status compliance gate, insight targets, the per-medication
 * tile) keeps reading the same fields. Only the math underneath the
 * fields was wrong — that's what got fixed. Closes #214.
 *
 * `classifyIntakeTiming` is unchanged and still owns the early /
 * on_time / late / very_late punctuality bucket logic used by the
 * daily compliance heatmap on `/api/medications/[id]/compliance`.
 */

import {
  buildCadenceTimeline,
  type CadenceEngineContext,
  type IntakeEventLike,
  type ScheduleLike,
} from "@/lib/medications/scheduling/cadence";
import { streaksFromTimeline } from "@/lib/medications/scheduling/compliance";
import {
  expandRollingRetrospective,
  nextOccurrenceAfter,
  occurrencesBetween,
  type CanonicalSchedule,
  type Occurrence,
  type RecurrenceContext,
  type ScheduleType,
} from "@/lib/medications/scheduling/recurrence";

interface IntakeEvent {
  takenAt: Date | null;
  skipped: boolean;
  scheduledFor: Date;
  /**
   * v1.15.9 — true when the auto-miss cron marked this never-acted dose as
   * a forgotten miss. Threaded into the cadence timeline so it counts as a
   * `missed` slot (against the rate) instead of being neutralised. Optional
   * so pre-v1.15.9 callers / fixtures default it to a normal pending/taken
   * row.
   */
  autoMissed?: boolean;
}

export type IntakeTimingClass =
  | "early"
  | "on_time"
  | "late"
  | "very_late"
  | "missed";

export interface ComplianceResult {
  totalExpected: number;
  taken: number;
  skipped: number;
  missed: number;
  rate: number; // 0-100
  streak: number; // consecutive days with all taken
}

/**
 * Daily compliance data including timing breakdown.
 *
 * `early` is the v1.4.34 bucket for doses taken before the window's
 * 3-hour grace start. Consumers that group by compliance status
 * should treat `early` as compliant (alongside `onTime`).
 */
export interface DailyComplianceEntry {
  expected: number;
  /**
   * v1.7.0 item 5 — the true engine-computed due-slot count for the day.
   * Equals `expected`; carried as an explicit additive field iOS keys
   * off so it doesn't have to infer "due-ness" from `expected`.
   */
  expectedCount: number;
  /**
   * v1.7.0 item 5 — `expectedCount > 0`. iOS renders a "missed" mark
   * only when `due === true`, so off-weeks / non-matching weekdays / PRN
   * days no longer paint a false miss.
   */
  due: boolean;
  taken: number;
  skipped: number;
  onTime: number;
  late: number;
  veryLate: number;
  early?: number;
}

/**
 * Parse "HH:mm" into hours and minutes.
 */
function parseHHmm(time: string): { hours: number; minutes: number } {
  const [h, m] = time.split(":").map(Number);
  return { hours: h, minutes: m };
}

/**
 * Build a Date for a given "HH:mm" on a specific date.
 */
function toDateOnDay(time: string, day: Date): Date {
  const { hours, minutes } = parseHHmm(time);
  const d = new Date(day);
  d.setUTCHours(hours, minutes, 0, 0);
  return d;
}

/**
 * Classify how punctual an intake was relative to a schedule window.
 *
 * v1.4.34 IW-C — widened pre-window grace from 1h to 3h and introduced
 * a dedicated `early` bucket so a proactive logger (e.g. 10 min before
 * the window) no longer gets flushed into `very_late`. The post-window
 * grace likewise grew to 3h so a "20 minutes late" dose stays `on_time`.
 * Only doses beyond a 3-hour late tolerance fall into `late`, and only
 * doses beyond a further `lateMinutes` tail fall into `very_late`.
 *
 * Buckets:
 * - "early":     within (windowStart - 3h) .. windowStart           (compliant)
 * - "on_time":   windowStart .. (windowEnd + 3h)                    (compliant)
 * - "late":      (windowEnd + 3h) .. (windowEnd + 3h + lateMinutes) (default 2h tail)
 * - "very_late": before windowStart - 3h, or after the late tail
 * - "missed":    takenAt is null
 *
 * Handles overnight windows (windowEnd < windowStart means next day).
 *
 * @param options.lateMinutes Width of the `late` band beyond the 3-hour
 *   on-time tolerance, in minutes. Defaults to 120. Doses past this
 *   tail land in `very_late`.
 */
export function classifyIntakeTiming(
  takenAt: Date | null,
  windowStart: string, // "HH:mm"
  windowEnd: string, // "HH:mm"
  scheduledDate: Date, // the date this was scheduled
  options?: { lateMinutes?: number },
): IntakeTimingClass {
  if (takenAt === null) return "missed";

  const start = toDateOnDay(windowStart, scheduledDate);
  let end = toDateOnDay(windowEnd, scheduledDate);

  // Handle overnight windows (e.g. windowStart="23:00", windowEnd="01:00")
  if (end <= start) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  }

  const HOUR_MS = 60 * 60 * 1000;
  // 3h pre-window grace: doses inside this window are `early` (still
  // compliant). Doses before it are `very_late`.
  const earlyStart = new Date(start.getTime() - 3 * HOUR_MS);
  // 3h post-window grace: doses up to here are still `on_time`.
  const onTimeEnd = new Date(end.getTime() + 3 * HOUR_MS);
  // Configurable `late` tail past the on-time grace (default 120 min).
  const lateTolerance = (options?.lateMinutes ?? 120) * 60 * 1000;
  const lateEnd = new Date(onTimeEnd.getTime() + lateTolerance);

  const t = takenAt.getTime();

  if (t < earlyStart.getTime()) return "very_late";
  if (t < start.getTime()) return "early";
  if (t <= onTimeEnd.getTime()) return "on_time";
  if (t <= lateEnd.getTime()) return "late";
  return "very_late";
}

/**
 * v1.15.9 — cadence-aware per-dose grace/miss window model.
 *
 * A medication's dose either is on-time, is still takeable but late
 * (counts when taken), or has slipped past the point where a self-hoster
 * could plausibly still take it (a MISS). The cutoffs differ by cadence:
 * an intraday/daily dose has tight hour-scale windows; a weekly/rolling
 * injectable (the GLP-1 case) follows the clinical "take it within 4 days,
 * otherwise skip to the next scheduled dose" rule.
 *
 * The defaults below are centralised named constants so a future revision
 * can expose them per-medication without re-deriving the boundaries. Make
 * it correct first; configurability later.
 *
 * DAILY / INTRADAY (minute-scale windows around the target instant):
 *   - on-time:    target − 60 min … target + 60 min
 *   - overdue:    target + 60 min … target + 240 min  (still takeable)
 *   - missed:     > target + 240 min, OR the next dose's on-time window
 *                 starts first (whichever is sooner — adjacent doses never
 *                 overlap).
 *
 * WEEKLY / ROLLING injectable (day-scale windows; the 4-day clinical rule):
 *   - on-time:    target day ± 1 day
 *   - overdue:    up to target + 4 days  (late-but-counts)
 *   - missed:     > target + 4 days
 */
export const DOSE_WINDOW_DEFAULTS = {
  /** Daily / intraday on-time half-width around the target instant (min). */
  dailyOnTimeMinutes: 60,
  /**
   * Daily / intraday overdue tail past the on-time window (min). A dose
   * taken inside `[onTime, onTime + overdue]` still counts; beyond it the
   * dose is missed.
   */
  dailyOverdueMinutes: 240 - 60,
  /** Weekly / rolling on-time half-width around the target day (days). */
  weeklyOnTimeDays: 1,
  /**
   * Weekly / rolling overdue tail past the target day (days) — the clinical
   * 4-day GLP-1 rule. A shot inside `[target, target + 4d]` still counts;
   * beyond it the dose is missed and the user skips to the next slot.
   */
  weeklyOverdueDays: 4,
} as const;

/**
 * v1.15.9 — the derived per-dose state the medication card renders.
 *
 *   - `on_time_window` — due now, inside the on-time window (green).
 *   - `overdue`        — past on-time, before the miss cutoff (still
 *                        takeable; the card escalates the tint as it nears
 *                        the cutoff — "stark überfällig").
 *   - `missed`         — past the miss cutoff, never acted on.
 *   - `taken_on_time`  — taken inside the on-time window.
 *   - `taken_late`     — taken in the overdue window (still counts).
 *   - `skipped`        — a deliberate user skip (excluded from the rate).
 *   - `upcoming`       — the on-time window has not opened yet.
 *
 * PRN doses are never scheduled and so never produce a status — callers
 * exclude them before calling {@link deriveDoseStatus}.
 */
export type DoseStatus =
  | "upcoming"
  | "on_time_window"
  | "overdue"
  | "missed"
  | "taken_on_time"
  | "taken_late"
  | "skipped";

/** Cadence family the window math keys off. */
export type DoseCadenceFamily = "daily" | "weekly";

const HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * HOUR_MS;

/**
 * v1.15.9 — derive a single dose's {@link DoseStatus} from its target
 * instant, the cadence family, `now`, and (optionally) when it was taken /
 * whether the user skipped it. Pure and deterministic.
 *
 * `nextDoseAt` (when supplied) caps a daily dose's miss cutoff at the next
 * dose's on-time window start, so two adjacent intraday doses never claim
 * overlapping overdue windows — the earlier dose flips to `missed` the
 * moment the later one comes due if that is sooner than its own cutoff.
 *
 * The defaults come from {@link DOSE_WINDOW_DEFAULTS}; callers may override
 * per-medication once that configurability lands.
 */
export function deriveDoseStatus(
  targetAt: Date,
  cadence: DoseCadenceFamily,
  now: Date,
  options?: {
    takenAt?: Date | null;
    skipped?: boolean;
    nextDoseAt?: Date | null;
    windows?: Partial<typeof DOSE_WINDOW_DEFAULTS>;
  },
): DoseStatus {
  if (options?.skipped) return "skipped";

  const w = { ...DOSE_WINDOW_DEFAULTS, ...(options?.windows ?? {}) };
  const target = targetAt.getTime();

  let onTimeStart: number;
  let onTimeEnd: number;
  let overdueEnd: number;
  if (cadence === "weekly") {
    onTimeStart = target - w.weeklyOnTimeDays * ONE_DAY_MS;
    onTimeEnd = target + w.weeklyOnTimeDays * ONE_DAY_MS;
    overdueEnd = target + w.weeklyOverdueDays * ONE_DAY_MS;
  } else {
    onTimeStart = target - w.dailyOnTimeMinutes * 60_000;
    onTimeEnd = target + w.dailyOnTimeMinutes * 60_000;
    overdueEnd = onTimeEnd + w.dailyOverdueMinutes * 60_000;
  }

  // Never let the miss cutoff bleed into the next dose's on-time window.
  if (options?.nextDoseAt) {
    const nextOnTimeStart =
      cadence === "weekly"
        ? options.nextDoseAt.getTime() - w.weeklyOnTimeDays * ONE_DAY_MS
        : options.nextDoseAt.getTime() - w.dailyOnTimeMinutes * 60_000;
    if (nextOnTimeStart < overdueEnd) overdueEnd = nextOnTimeStart;
  }

  const takenAt = options?.takenAt ?? null;
  if (takenAt) {
    const t = takenAt.getTime();
    return t <= onTimeEnd ? "taken_on_time" : "taken_late";
  }

  const n = now.getTime();
  if (n < onTimeStart) return "upcoming";
  if (n <= onTimeEnd) return "on_time_window";
  if (n <= overdueEnd) return "overdue";
  return "missed";
}

/**
 * v1.15.9 — classify a schedule's cadence into the {@link DoseCadenceFamily}
 * the window model uses. A rolling cadence, or any RRULE / legacy weekly
 * cadence that emits less often than daily, is `weekly` (day-scale windows +
 * the 4-day rule); everything denser (daily, intraday multi-dose) is
 * `daily` (minute-scale windows).
 */
export function doseCadenceFamily(schedule: ComplianceSchedule): DoseCadenceFamily {
  if (schedule.rollingIntervalDays != null && schedule.rollingIntervalDays >= 2) {
    return "weekly";
  }
  const rrule = schedule.rrule ?? "";
  if (/FREQ=(WEEKLY|MONTHLY|YEARLY)/i.test(rrule)) return "weekly";
  // A legacy daysOfWeek restriction to specific weekdays (not every day)
  // dosed once a day is still effectively daily-cadence on the days it
  // fires; the per-slot window is minute-scale either way. Only the rolling
  // / calendar-sparse shapes use the day-scale 4-day rule.
  return "daily";
}

/**
 * v1.5.0 — schedule view consumed by the cadence-aware adapter.
 *
 * Accepts the historical `ScheduleWindow` shape (`windowStart` +
 * `windowEnd` only) as well as the richer `ScheduleLike` shape that
 * carries `daysOfWeek`. When `daysOfWeek` is missing the schedule is
 * treated as `null` (daily, every day) so legacy fixtures keep
 * passing without modification.
 */
export interface ComplianceSchedule {
  windowStart: string; // HH:mm
  windowEnd: string; // HH:mm
  daysOfWeek?: string | null;
  /**
   * v1.7.0 SB-SCHED-2 — canonical-engine fields. When present (and a
   * `medicationContext` is threaded into `calculateCompliance`), the
   * expected-slot grid is computed through the canonical recurrence
   * engine, so an `rrule = "FREQ=WEEKLY;BYDAY=MO"` schedule counts only
   * Mondays in the denominator instead of every day. Absent fields keep
   * the legacy `daysOfWeek` path — existing fixtures / callers that pass
   * only `{ windowStart, windowEnd }` behave exactly as before.
   */
  rrule?: string | null;
  rollingIntervalDays?: number | null;
  timesOfDay?: string[];
  reminderGraceMinutes?: number | null;
  scheduleType?: ScheduleType | null;
  cyclicOnWeeks?: number | null;
  cyclicOffWeeks?: number | null;
}

/**
 * v1.7.0 SB-SCHED-2 — medication-level context the canonical engine
 * needs to expand expected slots. When supplied, `calculateCompliance`
 * routes the denominator through the engine; when omitted, every
 * schedule falls back to the legacy weekday walker (the byte-stable
 * pre-v1.7 behaviour that the parity fixtures pin).
 */
export interface ComplianceMedicationContext {
  startsOn: Date | null;
  endsOn: Date | null;
  oneShot: boolean;
  createdAt: Date;
  lastIntakeAt: Date | null;
  timeZone: string;
}

/**
 * v1.7.0 SB-SCHED-2 — convenience builder so the eight compliance call
 * sites don't each re-spell the context shape. Pass the medication row
 * (any object carrying the course-window fields), the latest non-skipped
 * intake instant, and the user's timezone.
 */
export function buildComplianceMedicationContext(
  med: {
    startsOn: Date | null;
    endsOn: Date | null;
    oneShot: boolean;
    createdAt: Date;
  },
  lastIntakeAt: Date | null,
  timeZone: string,
): ComplianceMedicationContext {
  return {
    startsOn: med.startsOn,
    endsOn: med.endsOn,
    oneShot: med.oneShot,
    createdAt: med.createdAt,
    lastIntakeAt,
    timeZone,
  };
}

/**
 * v1.7.0 SB-SCHED-2 — the latest non-skipped `takenAt` across an event
 * list (rolling cadences re-anchor on it). Returns null when the user
 * has never logged a non-skipped intake. Order-independent, so the
 * caller can pass an events array in any sort order.
 */
export function lastNonSkippedTakenAt(
  events: { takenAt: Date | null; skipped: boolean }[],
): Date | null {
  return events.reduce<Date | null>((latest, e) => {
    if (e.skipped || e.takenAt === null) return latest;
    if (latest === null || e.takenAt.getTime() > latest.getTime()) {
      return e.takenAt;
    }
    return latest;
  }, null);
}

/**
 * v1.13.x — the non-skipped `takenAt` instants at or before `now`, ascending.
 * These anchor the retrospective rolling expected-dose grid (each logged dose
 * is one satisfied expected slot). The full history is passed — not just the
 * compliance window — so the gap-walk between consecutive intakes (which
 * synthesizes skipped-cycle misses) and the forward next-due anchor stay
 * correct across the window boundary; `expandRollingRetrospective` clamps the
 * emitted slots to its own `[from, to]`.
 */
function rollingIntakeInstants(
  events: { takenAt: Date | null; skipped: boolean }[],
  now: Date,
): Date[] {
  return events
    .filter(
      (e): e is { takenAt: Date; skipped: boolean } =>
        !e.skipped && e.takenAt !== null && e.takenAt.getTime() <= now.getTime(),
    )
    .map((e) => e.takenAt)
    .sort((a, b) => a.getTime() - b.getTime());
}

/**
 * v1.8.5 — adapt a compliance medication context to the canonical engine's
 * {@link RecurrenceContext}. The synthetic medication `id` only labels the
 * row for the engine's internal logging; the `idTag` keeps the two callers'
 * historical prefixes (`compliance-daily` vs `compliance-slots`) distinct.
 */
function toRecurrenceCtx(
  ctx: ComplianceMedicationContext,
  idTag: string,
): RecurrenceContext {
  return {
    medication: {
      id: idTag,
      startsOn: ctx.startsOn,
      endsOn: ctx.endsOn,
      oneShot: ctx.oneShot,
      createdAt: ctx.createdAt,
    },
    timeZone: ctx.timeZone,
    lastIntakeAt: ctx.lastIntakeAt,
  };
}

/**
 * v1.8.5 — adapt a {@link ComplianceSchedule} to the canonical engine's
 * {@link CanonicalSchedule}, defaulting the optional fields the compliance
 * payload may omit. `id` is engine-internal labelling only.
 */
function toCanonicalSchedule(
  s: ComplianceSchedule,
  id: string,
): CanonicalSchedule {
  return {
    id,
    rrule: s.rrule ?? null,
    rollingIntervalDays: s.rollingIntervalDays ?? null,
    timesOfDay: s.timesOfDay ?? [],
    daysOfWeek: s.daysOfWeek ?? null,
    windowStart: s.windowStart,
    windowEnd: s.windowEnd,
    reminderGraceMinutes: s.reminderGraceMinutes ?? null,
    scheduleType: s.scheduleType ?? "SCHEDULED",
    cyclicOnWeeks: s.cyclicOnWeeks ?? null,
    cyclicOffWeeks: s.cyclicOffWeeks ?? null,
  };
}

/**
 * v1.13.x — non-skipped intake instants for the retrospective rolling grid,
 * mirroring {@link rollingIntakeInstants} but reading the public
 * `{ takenAt, skipped }[]` shape the `expectedSlots*` callers pass. The
 * `expectedSlots*` helpers accept this so their rolling denominator uses the
 * SAME expansion as the displayed-rate numerator in {@link calculateCompliance}.
 */
export interface ComplianceIntakeInstant {
  takenAt: Date | null;
  skipped: boolean;
}

function intakeInstantsAtOrBefore(
  intakes: ComplianceIntakeInstant[],
  now: Date,
): Date[] {
  return intakes
    .filter(
      (e): e is { takenAt: Date; skipped: boolean } =>
        !e.skipped && e.takenAt !== null && e.takenAt.getTime() <= now.getTime(),
    )
    .map((e) => e.takenAt)
    .sort((a, b) => a.getTime() - b.getTime());
}

/**
 * v1.13.x — expand one schedule's expected occurrences over `[from, to]`,
 * routing a ROLLING schedule through the retrospective builder when intake
 * history is supplied (`intakeInstants` + `now`) and the forward-only engine
 * path for every other shape. This is the single expansion the slot-count
 * helpers and the displayed-rate timeline both delegate to, so the heatmap
 * `due` flags, the window-selection denominator, and the percentage agree.
 */
function expandComplianceOccurrences(
  canonical: CanonicalSchedule,
  recurrenceCtx: RecurrenceContext,
  from: Date,
  to: Date,
  retro: { intakeInstants: Date[]; now: Date } | undefined,
): Occurrence[] {
  if (retro && canonical.rollingIntervalDays !== null) {
    return expandRollingRetrospective(
      canonical,
      recurrenceCtx,
      from,
      to,
      retro.intakeInstants,
      retro.now,
    );
  }
  return occurrencesBetween(canonical, from, to, recurrenceCtx);
}

/**
 * v1.7.0 item 5 — count the expected dose slots a medication's schedules
 * emit inside `[dayStart, dayEnd)`, routed through the canonical engine.
 * Powers the per-day `due` / `expectedCount` fields on the per-med
 * compliance payload so iOS history renders a "missed" mark only on days
 * the schedule actually expected a dose (not off-weeks / non-matching
 * weekdays / PRN days).
 *
 * v1.13.x — pass `intakes` so a ROLLING schedule routes through the
 * retrospective grid (each logged dose is a `due` day, plus skipped-cycle
 * misses + a past-due forward slot) instead of the engine's single forward
 * slot. Omitting `intakes` keeps the forward-only behaviour for callers that
 * don't have the intake history at hand.
 */
export function expectedSlotCountForDay(
  schedules: ComplianceSchedule[],
  dayStart: Date,
  dayEnd: Date,
  ctx: ComplianceMedicationContext,
  intakes?: ComplianceIntakeInstant[],
): number {
  let count = 0;
  const recurrenceCtx = toRecurrenceCtx(ctx, "compliance-daily");
  const now = new Date();
  const retro =
    intakes && schedules.some((s) => s.rollingIntervalDays != null)
      ? { intakeInstants: intakeInstantsAtOrBefore(intakes, now), now }
      : undefined;
  for (let i = 0; i < schedules.length; i++) {
    count += expandComplianceOccurrences(
      toCanonicalSchedule(schedules[i], `compliance-daily-${i}`),
      recurrenceCtx,
      dayStart,
      // occurrencesBetween is inclusive of both ends; subtract 1 ms so a
      // slot exactly at the next day's midnight doesn't double-count.
      new Date(dayEnd.getTime() - 1),
      retro,
    ).length;
  }
  return count;
}

/**
 * v1.8.5 — the sibling of {@link expectedSlotCountForDay} that returns the
 * expected-dose occurrences *themselves* (ascending by instant) over an
 * arbitrary window, rather than just the per-day count. Same loop, same
 * canonical-engine delegation; we keep the slots so the dose-adherence
 * timeline can pair each expected slot to its intake.
 *
 * Used by {@link buildComplianceDisplay} to decide the card's render mode
 * (percent bars vs an uptime-style per-dose strip) and to build the strip.
 * `occurrencesBetween` is inclusive of both ends; the caller passes a
 * `[from, to]` window and we sort the union of every schedule's slots so
 * a multi-schedule medication interleaves its slots in time order.
 *
 * v1.8.6 QA — the window lower bound is clamped to `ctx.createdAt`. The
 * legacy weekday walker floors on `startsOn` but not on `createdAt`, so a
 * brand-new daily med queried over a 30-day window would otherwise emit
 * slots for every day before it existed (7/30 expected on a 2-day-old med).
 * Clamping here keeps the expected-dose denominator — and the window
 * selection that reads it — honest about the medication's real age. The
 * displayed rates clamp independently via `calculateCompliance`'s
 * `medicationCreatedAt` argument, so this only fixes the slot counts.
 */
export function expectedSlotsBetween(
  schedules: ComplianceSchedule[],
  from: Date,
  to: Date,
  ctx: ComplianceMedicationContext,
  intakes?: ComplianceIntakeInstant[],
): Occurrence[] {
  const recurrenceCtx = toRecurrenceCtx(ctx, "compliance-slots");
  const effectiveFrom =
    ctx.createdAt.getTime() > from.getTime() ? ctx.createdAt : from;
  // v1.13.x — for a ROLLING schedule the expected grid is reconstructed from
  // the intake history (each logged dose is one satisfied expected slot) so
  // the window-selection denominator matches the displayed rate. The forward
  // next-due slot counts only when past-due relative to `to` (the window's
  // upper bound), so a not-yet-due open cycle never inflates the count.
  const retro =
    intakes && schedules.some((s) => s.rollingIntervalDays != null)
      ? { intakeInstants: intakeInstantsAtOrBefore(intakes, to), now: to }
      : undefined;
  const all: Occurrence[] = [];
  for (let i = 0; i < schedules.length; i++) {
    all.push(
      ...expandComplianceOccurrences(
        toCanonicalSchedule(schedules[i], `compliance-slots-${i}`),
        recurrenceCtx,
        effectiveFrom,
        to,
        retro,
      ),
    );
  }
  return all.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * v1.8.6 — the floor at which a window's percentage is stable. Four
 * expected doses is the point where a single miss moves the rate by ≤25%
 * rather than ±50–100%. A daily med clears it in a 7-day window; a weekly
 * med needs ~30 days; a tri-weekly / 35-day-rolling med needs a quarter or
 * more. The window ladder below steps up until both rows clear this floor.
 */
export const MIN_STABLE_DOSES = 4;

/**
 * v1.8.6 — the rung ladder for the two compliance windows. Each rung is a
 * `[short, long]` pair of day-counts. The card always shows two percentage
 * rows; the only thing that scales with cadence is which rung the windows
 * sit on. Dense meds (daily / weekday) sit on `[7, 30]`; as the expected
 * dose frequency drops, both windows step up so each row still spans enough
 * expected doses to mean something, up to a 12-month long window for very
 * rare meds.
 */
export const COMPLIANCE_WINDOW_LADDER: ReadonlyArray<readonly [number, number]> =
  [
    [7, 30],
    [30, 90],
    [90, 365],
  ];

/**
 * v1.8.6 — the day-counts of the two compliance windows a medication's
 * cadence resolves to, plus the realised expected-dose count each window
 * holds. `shortDays` / `longDays` drive the row labels; the expected counts
 * are surfaced so a client can show the denominator or re-derive the rung.
 */
export interface ComplianceWindowSelection {
  shortDays: number;
  longDays: number;
  expectedShort: number;
  expectedLong: number;
}

/**
 * v1.8.6 — pick the two compliance windows for a medication from its
 * dosing cadence.
 *
 * Walks {@link COMPLIANCE_WINDOW_LADDER} from densest to sparsest and
 * returns the first rung whose BOTH windows clear {@link MIN_STABLE_DOSES}
 * realised expected doses. A daily med clears `[7, 30]` immediately; a
 * weekly med fails the 7-day row (one dose) and lands on `[30, 90]`; a
 * 35-day-rolling injection needs the top rung `[90, 365]`. When even the
 * top rung can't clear the floor (a brand-new prescription, a very rare
 * med) the top rung is returned anyway so the card still shows two honest
 * percentage rows over the widest windows available.
 *
 * The expected count routes through {@link expectedSlotsBetween} (the
 * canonical recurrence engine), so PRN / off-cadence / pre-creation days
 * never inflate the denominator.
 */
export function selectComplianceWindows(
  schedules: ComplianceSchedule[],
  ctx: ComplianceMedicationContext,
  options?: { now?: Date; intakes?: ComplianceIntakeInstant[] },
): ComplianceWindowSelection {
  const now = options?.now ?? new Date();
  const DAY_MS = 24 * 60 * 60 * 1000;

  const expectedOver = (days: number): number =>
    expectedSlotsBetween(
      schedules,
      new Date(now.getTime() - days * DAY_MS),
      now,
      ctx,
      options?.intakes,
    ).length;

  // Memoise per distinct window so a shared rung boundary (e.g. 30 / 90)
  // isn't re-walked across rungs.
  const cache = new Map<number, number>();
  const expected = (days: number): number => {
    const hit = cache.get(days);
    if (hit !== undefined) return hit;
    const v = expectedOver(days);
    cache.set(days, v);
    return v;
  };

  for (const [shortDays, longDays] of COMPLIANCE_WINDOW_LADDER) {
    const expectedShort = expected(shortDays);
    const expectedLong = expected(longDays);
    if (
      expectedShort >= MIN_STABLE_DOSES &&
      expectedLong >= MIN_STABLE_DOSES
    ) {
      return { shortDays, longDays, expectedShort, expectedLong };
    }
  }

  // No rung cleared the floor — fall back to the widest rung so both rows
  // still render over the most data the cadence affords.
  const [shortDays, longDays] =
    COMPLIANCE_WINDOW_LADDER[COMPLIANCE_WINDOW_LADDER.length - 1];
  return {
    shortDays,
    longDays,
    expectedShort: expected(shortDays),
    expectedLong: expected(longDays),
  };
}

/**
 * v1.8.6 — the compliance-display block returned alongside the existing
 * `compliance7` / `compliance30` fields (which iOS + the Health Score read
 * verbatim). The card always renders two percentage rows; the server picks
 * the two windows from the medication's cadence and computes each row's
 * rate over the chosen span. A dense med keeps `7` / `30`; a sparse med
 * steps both windows up so each row covers enough expected doses to be
 * meaningful.
 */
/**
 * v1.13.x Fix 4 — the current-cycle descriptor. SEPARATE from the
 * percentage rows: a sparse med (weekly+ injection) whose current cycle is
 * not yet due must NOT render a scary red 0%. The percentage rows reflect
 * only CLOSED cycles (the open forward cycle is `upcoming`, excluded from
 * the denominator); this descriptor carries the open-cycle state so the
 * card can render a neutral "next dose in N days" / "due today" / "overdue"
 * line decoupled from the rate.
 *
 * States:
 *   - `on_track`: `now < nextDueAt`. The next dose simply hasn't come round.
 *   - `due`: `nextDueAt ≤ now ≤ graceUntil`. A neutral / amber call-to-action.
 *   - `missed`: `now > graceUntil` and the cycle has no logged intake. The
 *     only state that should tint red.
 *   - `none`: no schedule projects a next dose (PRN, paused, ended). The
 *     card shows no current-cycle line.
 *
 * `hasClosedCycles` is false for a brand-new sparse med with zero closed
 * dose cycles — the card then surfaces a neutral "no closed dose cycles
 * yet" state instead of a misleading 100% / 0%.
 */
export type CurrentCycleState = "on_track" | "due" | "missed" | "none";

export interface CurrentCycle {
  state: CurrentCycleState;
  /** The open cycle's due instant (ISO via JSON). Null when `state === "none"`. */
  nextDueAt: Date | null;
  /** End of the due slot's grace window. Null when `state === "none"`. */
  graceUntil: Date | null;
  /**
   * Whether the trailing window holds at least one CLOSED dose cycle. When
   * false the percentage rows are vacuous (no closed cycle to score) and the
   * card should show a neutral "not enough data yet" state.
   */
  hasClosedCycles: boolean;
}

export interface ComplianceDisplay {
  shortDays: number;
  longDays: number;
  /** Realised expected dose count over the short window. */
  expectedShort: number;
  /** Realised expected dose count over the long window. */
  expectedLong: number;
  /** Echo of the density floor so a client can re-derive the rung. */
  minStableDoses: number;
  /**
   * Compliance percentage + counts + day-streak over the short window.
   * `taken` is the numerator the card renders next to the rate so two
   * identical percentages stay distinguishable and trustworthy; `expected`
   * is the rate denominator (taken + missed, EXCLUDING user skips) and
   * `missed` the count counting against the rate. The card can render
   * "26 / 30 · 87%" from `taken` / `expected`.
   */
  short: { rate: number; taken: number; expected: number; missed: number; streak: number };
  /** Compliance percentage + counts over the long window. */
  long: { rate: number; taken: number; expected: number; missed: number };
  /**
   * v1.13.x Fix 4 — the open-cycle state, decoupled from the percentage
   * rows so a between-doses sparse med never renders a scary red number.
   */
  currentCycle: CurrentCycle;
}

/**
 * v1.13.x Fix 4 — classify the medication's open (current) dose cycle.
 *
 * Uses the canonical engine's {@link nextOccurrenceAfter} to find the
 * earliest projected dose at or after the start of the search (one ms before
 * `now` so a slot landing exactly now is captured). The rolling branch of
 * `nextOccurrenceAfter` floors to the start of the user's current day, so an
 * overdue rolling dose still surfaces as the next slot — that lets us tell a
 * not-yet-due (`on_track`) cycle apart from an overdue one (`due` / `missed`).
 *
 * `hasClosedCycles` reads `expectedShort` from the already-computed window
 * selection: a window holding zero expected (closed) doses means the
 * percentage rows are vacuous and the card should show a neutral state.
 */
export function buildCurrentCycle(
  schedules: ComplianceSchedule[],
  ctx: ComplianceMedicationContext,
  now: Date,
  expectedShort: number,
  intakes?: ComplianceIntakeInstant[],
): CurrentCycle {
  const recurrenceCtx = toRecurrenceCtx(ctx, "compliance-cycle");
  const DAY_MS = 24 * 60 * 60 * 1000;
  const lastIntakeAt =
    lastNonSkippedTakenAt(intakes ?? []) ?? ctx.lastIntakeAt;

  // The open cycle's due instant + grace, picked as the SOONEST across every
  // schedule. Two paths:
  //   - ROLLING: the engine's `nextOccurrenceAfter` deliberately rolls an
  //     overdue re-anchored dose forward (it floors to the start of the
  //     user's current day), so it cannot surface an open cycle that is more
  //     than a day overdue. For the current-cycle descriptor we instead
  //     compute the due instant directly: `(lastNonSkippedIntake) + N` (or
  //     `startsOn ?? createdAt` with no intake). This is what lets `due` /
  //     `missed` be distinguished from `on_track`.
  //   - NON-ROLLING: `nextOccurrenceAfter` already surfaces the next due
  //     slot (RRULE / legacy / one-shot / cyclic).
  let dueAt: Date | null = null;
  let graceUntil: Date | null = null;
  const consider = (at: Date, grace: Date): void => {
    if (dueAt === null || at.getTime() < dueAt.getTime()) {
      dueAt = at;
      graceUntil = grace;
    }
  };

  for (let i = 0; i < schedules.length; i++) {
    const s = schedules[i];
    const canonical = toCanonicalSchedule(s, `compliance-cycle-${i}`);
    if (canonical.scheduleType === "PRN") continue;
    const n = canonical.rollingIntervalDays;
    if (n !== null && n > 0) {
      const anchor =
        lastIntakeAt !== null
          ? new Date(lastIntakeAt.getTime() + n * DAY_MS)
          : ctx.startsOn ?? ctx.createdAt;
      if (ctx.endsOn && anchor.getTime() > ctx.endsOn.getTime()) continue;
      const graceMs =
        (canonical.reminderGraceMinutes ?? 60) * 60 * 1000;
      consider(anchor, new Date(anchor.getTime() + graceMs));
      continue;
    }
    const occ = nextOccurrenceAfter(
      canonical,
      new Date(now.getTime() - 1),
      recurrenceCtx,
    );
    if (occ) consider(occ.at, occ.graceUntil);
  }

  const hasClosedCycles = expectedShort > 0;

  if (dueAt === null || graceUntil === null) {
    return { state: "none", nextDueAt: null, graceUntil: null, hasClosedCycles };
  }

  // Narrow the union-mutated locals for the comparisons below.
  const due: Date = dueAt;
  const grace: Date = graceUntil;
  let state: CurrentCycleState;
  if (now.getTime() < due.getTime()) {
    state = "on_track";
  } else if (now.getTime() <= grace.getTime()) {
    state = "due";
  } else {
    state = "missed";
  }

  return { state, nextDueAt: due, graceUntil: grace, hasClosedCycles };
}

/**
 * v1.8.6 — compute the two-row {@link ComplianceDisplay} block.
 *
 * The card always shows two percentage rows. {@link selectComplianceWindows}
 * decides which windows they span from the medication's cadence, then each
 * row's rate is the cadence-aware {@link calculateCompliance} over that
 * window. The short row also carries the day-streak. The compliance math is
 * unchanged from the legacy 7-/30-day path — only the window day-counts move.
 */
export function buildComplianceDisplay(
  events: IntakeEvent[],
  schedules: ComplianceSchedule[],
  ctx: ComplianceMedicationContext,
  options?: { now?: Date },
): ComplianceDisplay {
  const now = options?.now ?? new Date();
  // v1.13.x — thread the intake history so a ROLLING cadence's window
  // selection scores the retrospective grid (each logged dose is a closed
  // cycle) rather than the engine's single forward slot. Without this a
  // weekly rolling med always falls through to the widest `[90, 365]` rung.
  const { shortDays, longDays, expectedShort, expectedLong } =
    selectComplianceWindows(schedules, ctx, { now, intakes: events });

  const short = calculateCompliance(events, schedules, shortDays, ctx.createdAt, {
    now,
    medicationContext: ctx,
  });
  const long = calculateCompliance(events, schedules, longDays, ctx.createdAt, {
    now,
    medicationContext: ctx,
  });

  // v1.13.x Fix 4 — the open-cycle descriptor, separable from the rates.
  const currentCycle = buildCurrentCycle(
    schedules,
    ctx,
    now,
    expectedShort,
    events,
  );

  return {
    shortDays,
    longDays,
    expectedShort,
    expectedLong,
    minStableDoses: MIN_STABLE_DOSES,
    // `expected` is the rate denominator (taken + missed) so the card can
    // render the trustworthy "taken / expected · rate%" triple; user skips
    // are excluded from it by construction (they never enter `missed`).
    short: {
      rate: short.rate,
      taken: short.taken,
      expected: short.taken + short.missed,
      missed: short.missed,
      streak: short.streak,
    },
    long: {
      rate: long.rate,
      taken: long.taken,
      expected: long.taken + long.missed,
      missed: long.missed,
    },
    currentCycle,
  };
}

/**
 * Calculate compliance for a medication over a given period.
 *
 * Honours `daysOfWeek` (e.g. `"1"` for Mondays only) and
 * `intervalWeeks` (bi-weekly, tri-weekly, …) by delegating to
 * `buildCadenceTimeline`. The denominator is the number of dose slots
 * the schedule actually emits inside the window — not
 * `schedules.length * days`. A user on a weekly Monday-only schedule
 * who takes every Monday for 30 days reports 100% adherence (4 of 4
 * Mondays) instead of the pre-v1.5.0 ~13% (4 of 30).
 *
 * Skipped doses are excluded from the denominator (deliberate user
 * decision, not a compliance failure). When the window contains no
 * expected doses (paused med, brand-new prescription, schedule that
 * never fires in the window) the helper returns `rate: 100` so the
 * empty state doesn't trip a "0% compliance" alarm downstream.
 *
 * Streak counts consecutive days, ending at `now`, where every
 * expected dose for the day was taken (or skipped). Days with no
 * expected dose (out-of-cadence weekdays, off-weeks on a bi-weekly
 * schedule) advance the streak — the user gets credit for not
 * breaking on non-scheduled days.
 *
 * @param events         Recorded intake events from
 *                       `MedicationIntakeEvent`. Only `scheduledFor`,
 *                       `takenAt`, `skipped` are read.
 * @param schedules      Schedule rows for the medication. `daysOfWeek`
 *                       is read when present; missing field is treated
 *                       as daily.
 * @param days           Rolling-window size in days (typically 7 / 30
 *                       / 90).
 * @param medicationCreatedAt
 *                       When provided, days before the medication
 *                       existed are excluded so they don't count as
 *                       "missed".
 * @param options.now    Override for the rolling-window anchor. The
 *                       fast-path Health-Score helper passes a fixed
 *                       `now` so cached medication-compliance rates
 *                       agree with the score's other pillars; default
 *                       is `new Date()` (current wall-clock instant).
 *                       v1.5.0 — added so the cadence-aware adapter
 *                       can be driven deterministically from a caller
 *                       that already pinned its own `now`.
 */
export function calculateCompliance(
  events: IntakeEvent[],
  schedules: ComplianceSchedule[],
  days: number,
  medicationCreatedAt?: Date,
  options?: { now?: Date; medicationContext?: ComplianceMedicationContext },
): ComplianceResult {
  if (schedules.length === 0) {
    return {
      totalExpected: 0,
      taken: 0,
      skipped: 0,
      missed: 0,
      rate: 100,
      streak: 0,
    };
  }

  const now = options?.now ?? new Date();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const periodStart = new Date(now.getTime() - days * DAY_MS);
  const effectiveStart =
    medicationCreatedAt && medicationCreatedAt > periodStart
      ? medicationCreatedAt
      : periodStart;
  const effectiveDays = Math.max(
    1,
    Math.ceil((now.getTime() - effectiveStart.getTime()) / DAY_MS),
  );

  // Normalise the schedule shape so legacy callers that pass only
  // `{ windowStart, windowEnd }` still produce a usable `daysOfWeek`
  // field (treated as daily by the cadence parser).
  const normalisedSchedules: ScheduleLike[] = schedules.map((s, i) => ({
    id: `compliance-${i}`,
    windowStart: s.windowStart,
    windowEnd: s.windowEnd,
    daysOfWeek: s.daysOfWeek ?? null,
    // v1.7.0 SB-SCHED-2 — thread the canonical-engine fields so the
    // cadence expander can delegate to `occurrencesBetween` when a
    // medication context is supplied. Undefined fields collapse to the
    // legacy weekday path inside `expandScheduleSlots`.
    rrule: s.rrule ?? null,
    rollingIntervalDays: s.rollingIntervalDays ?? null,
    timesOfDay: s.timesOfDay,
    reminderGraceMinutes: s.reminderGraceMinutes ?? null,
    scheduleType: s.scheduleType ?? null,
    cyclicOnWeeks: s.cyclicOnWeeks ?? null,
    cyclicOffWeeks: s.cyclicOffWeeks ?? null,
  }));

  // v1.7.0 SB-SCHED-2 — build the engine context once per medication.
  // When the caller supplies it, the timeline routes through the
  // canonical engine (RRULE / rolling / one-shot / PRN / cyclic);
  // otherwise the legacy weekday walker stays in force.
  const ctx = options?.medicationContext;
  const engineCtx: CadenceEngineContext | undefined = ctx
    ? {
        startsOn: ctx.startsOn,
        endsOn: ctx.endsOn,
        oneShot: ctx.oneShot,
        createdAt: ctx.createdAt,
        lastIntakeAt: ctx.lastIntakeAt,
        timeZone: ctx.timeZone,
      }
    : undefined;

  // Match events against the same slot grid the cadence chart uses.
  // The chart's pairing radius is ±12 h so a late-by-six-hours dose
  // still attaches to the right slot instead of double-counting as
  // "missed + extra".
  const normalisedEvents: IntakeEventLike[] = events
    .filter((e) => e.scheduledFor >= effectiveStart && e.scheduledFor <= now)
    .map((e) => ({
      scheduledFor: e.scheduledFor,
      takenAt: e.takenAt,
      skipped: e.skipped,
      // v1.15.9 — carry the forgotten-dose flag into the timeline so an
      // auto-missed slot pairs to a `missed` status (counts against the
      // rate) rather than a neutral `skipped`.
      autoMissed: e.autoMissed ?? false,
    }));

  // v1.13.x — ROLLING retrospective expansion. A rolling cadence
  // (`rollingIntervalDays`, the canonical GLP-1 "every N days" shape) is
  // forward-only in the engine: `expandRolling` emits at most the single
  // immediately-next slot, so a historical compliance window saw either
  // zero expected slots (vacuous 100%) or one overdue slot (hard 0%) —
  // never the true multi-dose adherence over the trailing window. When a
  // medication context is threaded AND any schedule is rolling, route the
  // rolling schedules through the retrospective builder so each logged dose
  // is one satisfied expected slot (plus synthesized misses for skipped
  // whole cycles + a past-due forward slot). Non-rolling schedules keep the
  // forward-only engine path; both share `buildCadenceTimeline` so the
  // numerator and denominator agree (the v1.7.3 B15 convergence rule).
  const hasRolling = schedules.some(
    (s) => s.rollingIntervalDays != null && s.rollingIntervalDays > 0,
  );
  const retro =
    engineCtx && hasRolling
      ? { intakeInstants: rollingIntakeInstants(events, now), now }
      : undefined;

  const timeline = buildCadenceTimeline(
    normalisedSchedules,
    normalisedEvents,
    now,
    effectiveDays,
    medicationCreatedAt ?? effectiveStart,
    engineCtx?.timeZone,
    engineCtx,
    retro,
  );

  let taken = 0;
  let skipped = 0;
  let missed = 0;
  for (const slot of timeline) {
    if (slot.status === "taken") taken++;
    else if (slot.status === "skipped") skipped++;
    else if (slot.status === "missed") missed++;
    // `upcoming` slots (future window) are excluded from every counter
    // so a partial day at the head of the window doesn't pollute the rate.
  }

  const totalExpected = taken + skipped + missed;
  // Skipped doses are excluded from the denominator — they represent a
  // deliberate user decision rather than a missed dose.
  const denom = taken + missed;
  const rate =
    denom > 0 ? Math.min(100, Math.round((taken / denom) * 100)) : 100;

  // Streak: consecutive days, ending today, where every expected dose
  // was taken or skipped. Days with no expected dose advance the
  // streak — out-of-cadence days are not failures. Delegated to the
  // shared `streaksFromTimeline` so the analytics streak and the
  // detail-page chip streak agree on every dose AND so the day keys are
  // computed in the USER's IANA timezone, not the host's. The prior
  // host-tz `getFullYear/getMonth/getDate` walk drifted off by a day
  // whenever the server clock's zone differed from the user's — the
  // timeline `slot.day` is already minted in the user zone, so the
  // walk has to match it. The window is `effectiveDays` ending at
  // `now`, which starts no earlier than `effectiveStart` (= the later
  // of the period start and the medication's creation) — so days
  // before the medication existed are never iterated, preserving the
  // old `cursor <= medicationCreatedAt` break by construction.
  const { current: streak } = streaksFromTimeline(
    timeline,
    now,
    effectiveDays,
    engineCtx?.timeZone,
  );

  return { totalExpected, taken, skipped, missed, rate, streak };
}
