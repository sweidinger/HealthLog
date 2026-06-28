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

import type { SlotBand } from "@/lib/medications/scheduling/attribution";
import {
  type BandMinterMedication,
  type DoseWindowConfig,
} from "@/lib/medications/scheduling/band-minter";
import {
  buildBandsForSchedulesWithEras,
  occurrencesAcrossEras,
  type ScheduleRevisionLike,
} from "@/lib/medications/scheduling/schedule-eras";
import {
  buildCadenceTimeline,
  type CadenceEngineContext,
  type IntakeEventLike,
  type ScheduleLike,
} from "@/lib/medications/scheduling/cadence";
import { streaksFromTimeline } from "@/lib/medications/scheduling/compliance";
import { DOSE_WINDOW_DEFAULTS } from "@/lib/medications/scheduling/dose-window-defaults";
import { normaliseDoseWindows } from "@/lib/medications/scheduling/worker-helpers";
import {
  reconstructDoseHistory,
  type DoseHistoryRow,
  type HistoryIntake,
} from "@/lib/medications/scheduling/dose-history";
import {
  expandRollingRetrospective,
  nextOccurrenceAfter,
  occurrencesBetween,
  type CanonicalSchedule,
  type Occurrence,
  type RecurrenceContext,
  type ScheduleType,
} from "@/lib/medications/scheduling/recurrence";
import { toBerlinDayKey } from "@/lib/tz/resolver";

export interface IntakeEvent {
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
  /**
   * v1.15.20 — slot-binding provenance. `USER_PIN` = the user deliberately
   * pinned this off-window take onto its `scheduledFor` slot; the unified
   * ledger then binds it by anchor (taken-late, never on-time-washed)
   * instead of degrading it to ad-hoc when the takenAt sits outside the
   * band tail. Optional so legacy callers / fixtures default to AUTO.
   */
  attributionSource?: "AUTO" | "USER_PIN";
}

export type IntakeTimingClass =
  "early" | "on_time" | "late" | "very_late" | "missed";

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
export { DOSE_WINDOW_DEFAULTS };

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
export function doseCadenceFamily(
  schedule: ComplianceSchedule,
): DoseCadenceFamily {
  if (
    schedule.rollingIntervalDays != null &&
    schedule.rollingIntervalDays >= 2
  ) {
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
  /**
   * v1.15.18 — per-dose configurable on-time windows. Threaded onto the
   * canonical schedule so `tallyComplianceFromLedger` builds the on-time band
   * from the explicit `[start, end]` range — keeping the % exactly aligned with
   * the dose-history view and the write/edit attribution (all consume the same
   * minter). Accepts the raw persisted JSON (a full Prisma row drops straight
   * in); `toCanonicalSchedule` normalises it via `normaliseDoseWindows`.
   */
  doseWindows?: unknown;
}

/**
 * v1.15.20 — the ONE Prisma `select` for schedule rows feeding a compliance
 * computation. Every call site that loads schedules for
 * `calculateCompliance` / the cadence helpers must use this constant instead
 * of hand-rolling a field list (or an unbounded `include: { schedules:
 * true }`), so a future schedule column that the engine consumes — the way
 * `doseWindows` joined in v1.15.18 — reaches every surface the moment it is
 * added here. Covers the full {@link ComplianceSchedule} shape plus `id`
 * (engine-internal labelling / diagnostics).
 */
export const SCHEDULE_COMPLIANCE_SELECT = {
  id: true,
  windowStart: true,
  windowEnd: true,
  daysOfWeek: true,
  timesOfDay: true,
  reminderGraceMinutes: true,
  rrule: true,
  rollingIntervalDays: true,
  scheduleType: true,
  cyclicOnWeeks: true,
  cyclicOffWeeks: true,
  // The configurable per-dose on-time windows. Selecting them everywhere is
  // the point: a user-configured "07:00–09:00" band must shape the rate on
  // the dashboard pillar, the insights features, the BP-status gate and the
  // report exactly as it shapes the medication detail page.
  doseWindows: true,
} as const;

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
  /**
   * v1.16.3 — archived schedule eras (`validFrom` ascending). When present,
   * every expected-slot expansion + band mint segments its range so a past
   * day counts/mints against the schedule that was live THEN. Optional:
   * callers without revisions keep the live-only expansion.
   */
  scheduleRevisions?: ScheduleRevisionLike[];
  /**
   * v1.25 H-MED1 — durable pause intervals (`MedicationPauseEra`). When
   * present, expected dose slots whose anchor falls inside any
   * `[pausedAt, resumedAt ?? now)` interval are dropped from the ledger so a
   * resumed medication never counts the paused days as missed. Optional:
   * callers without eras keep counting every expected slot.
   */
  pauseEras?: MedicationPauseEraLike[];
}

/**
 * v1.25 H-MED1 — the pause-interval projection the compliance engine reads.
 * A Prisma `MedicationPauseEra` row (or a `{ pausedAt, resumedAt }` literal)
 * drops in. An open era (`resumedAt === null`) runs to `now`.
 */
export interface MedicationPauseEraLike {
  pausedAt: Date;
  resumedAt: Date | null;
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
    /** v1.16.3 — thread the archived eras when the bundle carries them. */
    scheduleRevisions?: ScheduleRevisionLike[];
    /** v1.25 H-MED1 — thread the pause eras when the caller carries them. */
    pauseEras?: MedicationPauseEraLike[];
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
    ...(med.scheduleRevisions && { scheduleRevisions: med.scheduleRevisions }),
    ...(med.pauseEras && { pauseEras: med.pauseEras }),
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
        !e.skipped &&
        e.takenAt !== null &&
        e.takenAt.getTime() <= now.getTime(),
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
    doseWindows: normaliseDoseWindows(s.doseWindows),
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
  /**
   * v1.15.10 — the dose slot this intake resolves (the canonical snapped
   * instant, byte-identical to the engine occurrence's `.at`). Optional so
   * every legacy caller / fixture that omits it keeps working; when present
   * the open-dose selection in {@link buildCurrentCycle} uses it to skip a
   * slot the user has already acted on (taken / skipped / auto-missed) so the
   * card advances to the next genuinely-open slot rather than re-surfacing a
   * resolved past dose.
   */
  scheduledFor?: Date;
  /**
   * v1.15.10 — the cron-flagged forgotten miss. A resolved (auto-missed) slot
   * is excluded from the open-dose search the same way a take / skip is.
   */
  autoMissed?: boolean;
}

function intakeInstantsAtOrBefore(
  intakes: ComplianceIntakeInstant[],
  now: Date,
): Date[] {
  return intakes
    .filter(
      (e): e is { takenAt: Date; skipped: boolean } =>
        !e.skipped &&
        e.takenAt !== null &&
        e.takenAt.getTime() <= now.getTime(),
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
  const recurrenceCtx = toRecurrenceCtx(ctx, "compliance-daily");
  const now = new Date();
  const retro =
    intakes && schedules.some((s) => s.rollingIntervalDays != null)
      ? { intakeInstants: intakeInstantsAtOrBefore(intakes, now), now }
      : undefined;
  // v1.16.3 — era-aware: a past day counts the slots of the schedule that
  // was live THEN. With no revisions the single live era expands exactly
  // the per-schedule loop this used to run.
  return occurrencesAcrossEras(
    {
      from: dayStart,
      // occurrencesBetween is inclusive of both ends; subtract 1 ms so a
      // slot exactly at the next day's midnight doesn't double-count.
      to: new Date(dayEnd.getTime() - 1),
    },
    ctx.scheduleRevisions ?? [],
    schedules.map((s, i) => toCanonicalSchedule(s, `compliance-daily-${i}`)),
    (schedule, eraFrom, eraTo) =>
      expandComplianceOccurrences(
        schedule,
        recurrenceCtx,
        eraFrom,
        eraTo,
        retro,
      ),
    { oneShot: ctx.oneShot },
  ).length;
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
  if (effectiveFrom.getTime() > to.getTime()) return [];
  // v1.16.3 — era-aware: each archived era contributes the slots of ITS
  // schedules; the live rows cover only the range past the newest revision.
  return occurrencesAcrossEras(
    { from: effectiveFrom, to },
    ctx.scheduleRevisions ?? [],
    schedules.map((s, i) => toCanonicalSchedule(s, `compliance-slots-${i}`)),
    (schedule, eraFrom, eraTo) =>
      expandComplianceOccurrences(
        schedule,
        recurrenceCtx,
        eraFrom,
        eraTo,
        retro,
      ),
    { oneShot: ctx.oneShot },
  );
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
export const COMPLIANCE_WINDOW_LADDER: ReadonlyArray<
  readonly [number, number]
> = [
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
    if (expectedShort >= MIN_STABLE_DOSES && expectedLong >= MIN_STABLE_DOSES) {
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
  short: {
    rate: number;
    taken: number;
    expected: number;
    missed: number;
    streak: number;
  };
  /** Compliance percentage + counts over the long window. */
  long: { rate: number; taken: number; expected: number; missed: number };
  /**
   * v1.13.x Fix 4 — the open-cycle state, decoupled from the percentage
   * rows so a between-doses sparse med never renders a scary red number.
   */
  currentCycle: CurrentCycle;
  /**
   * v1.15.9 — the open cycle's per-dose {@link DoseStatus}, server-derived
   * so the card renders its state (green take-window, overdue / heavily-
   * overdue escalation) from one authority instead of re-deriving the window
   * math client-side. `status` is `upcoming` when no dose is open yet and
   * there is no projected next dose (PRN / paused / ended). `targetAt` is the
   * open dose's target instant (echo of `currentCycle.nextDueAt`).
   */
  currentDose: { status: DoseStatus; targetAt: Date | null };
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
/**
 * v1.15.10 — half-window an intake may sit from a slot's canonical instant
 * and still count as "resolving" that slot. The intake write paths snap
 * `scheduledFor` to the exact engine slot instant, so an exact (or
 * sub-minute) match is the common case; the ±6h tolerance also catches an
 * off-time take on a dense intraday cadence (e.g. a 07:00 dose logged 09:13)
 * whose snapped slot is the 07:00 row but whose raw instant we compare
 * defensively. It is the same ±half-gap radius the cadence pairer uses for a
 * 12h-gap (twice-daily) med, floored so a single-dose-a-day cadence still
 * matches its one slot.
 */
const OPEN_DOSE_RESOLVE_RADIUS_MS = 6 * 60 * 60 * 1000;

/**
 * v1.15.10 — true when an intake event has already resolved the slot at
 * `slotAt`. A resolved slot is one the user took, deliberately skipped, or
 * the auto-miss cron flagged — any of which means the card must NOT keep
 * surfacing that slot as the next dose. Matches on the snapped `scheduledFor`
 * first (the canonical, exact path) and falls back to the take/skip instant
 * within the resolve radius for rows that predate the snap or drifted.
 */
function slotIsResolved(
  slotAt: Date,
  intakes: ComplianceIntakeInstant[],
): boolean {
  const slot = slotAt.getTime();
  for (const e of intakes) {
    const isResolved = e.skipped || e.autoMissed === true || e.takenAt !== null;
    if (!isResolved) continue;
    const ref = (e.scheduledFor ?? e.takenAt) as Date | undefined;
    if (!ref) continue;
    if (Math.abs(ref.getTime() - slot) <= OPEN_DOSE_RESOLVE_RADIUS_MS) {
      return true;
    }
  }
  return false;
}

export function buildCurrentCycle(
  schedules: ComplianceSchedule[],
  ctx: ComplianceMedicationContext,
  now: Date,
  expectedShort: number,
  intakes?: ComplianceIntakeInstant[],
): CurrentCycle {
  const recurrenceCtx = toRecurrenceCtx(ctx, "compliance-cycle");
  const DAY_MS = 24 * 60 * 60 * 1000;
  const allIntakes = intakes ?? [];
  const lastIntakeAt = lastNonSkippedTakenAt(allIntakes) ?? ctx.lastIntakeAt;

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
          : (ctx.startsOn ?? ctx.createdAt);
      if (ctx.endsOn && anchor.getTime() > ctx.endsOn.getTime()) continue;
      const graceMs = (canonical.reminderGraceMinutes ?? 60) * 60 * 1000;
      consider(anchor, new Date(anchor.getTime() + graceMs));
      continue;
    }
    // v1.15.10 — advance past slots the user has already resolved. The
    // engine's `nextOccurrenceAfter` is purely time-anchored, so for a
    // twice-daily med it surfaces today's 19:00 slot in the afternoon even
    // after the user logged that dose early — the card then sticks on a
    // resolved past/present slot ("träge"). Walk occurrences forward and pick
    // the first one no intake has resolved (taken / skipped / auto-missed), so
    // a med whose remaining slots today are all logged advances to tomorrow's
    // first open slot. Bounded so a fully-logged-ahead history can't spin.
    let after = new Date(now.getTime() - 1);
    let picked: Occurrence | null = null;
    for (let step = 0; step < 64; step++) {
      const occ = nextOccurrenceAfter(canonical, after, recurrenceCtx);
      if (!occ) break;
      if (!slotIsResolved(occ.at, allIntakes)) {
        picked = occ;
        break;
      }
      // This slot is resolved — step strictly past it and keep looking.
      after = new Date(occ.at.getTime());
    }
    if (picked) consider(picked.at, picked.graceUntil);
  }

  const hasClosedCycles = expectedShort > 0;

  if (dueAt === null || graceUntil === null) {
    return {
      state: "none",
      nextDueAt: null,
      graceUntil: null,
      hasClosedCycles,
    };
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

  const short = calculateCompliance(
    events,
    schedules,
    shortDays,
    ctx.createdAt,
    {
      now,
      medicationContext: ctx,
    },
  );
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

  // v1.15.9 — derive the open dose's per-dose status from one server
  // authority so the card renders the take-window (green) / overdue /
  // heavily-overdue escalation without re-spelling the window math. The
  // cadence family comes from the SOONEST non-PRN schedule (the one the
  // open cycle anchors on). `none` cycles (PRN / paused / ended) carry an
  // `upcoming` status with a null target so the card stays calm.
  const currentDose: { status: DoseStatus; targetAt: Date | null } =
    currentCycle.nextDueAt
      ? {
          status: deriveDoseStatus(
            currentCycle.nextDueAt,
            soonestCadenceFamily(schedules),
            now,
          ),
          targetAt: currentCycle.nextDueAt,
        }
      : { status: "upcoming", targetAt: null };

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
    currentDose,
  };
}

/**
 * v1.15.9 — the {@link DoseCadenceFamily} of the soonest non-PRN schedule,
 * used to pick the window model for the open dose's status. A multi-schedule
 * med whose cycle anchors on its earliest window keeps that window's cadence;
 * when every schedule is PRN (no projected dose) the family is irrelevant
 * because the caller only reads `currentDose` when a cycle is open.
 */
function soonestCadenceFamily(
  schedules: ComplianceSchedule[],
): DoseCadenceFamily {
  for (const s of schedules) {
    if (s.scheduleType === "PRN") continue;
    return doseCadenceFamily(s);
  }
  return "daily";
}

/**
 * v1.15.18 — the unified compliance tally over the dose-history ledger.
 *
 * THE single source of the medication compliance %. It builds the
 * cadence-aware `SlotBand[]` per schedule (the shared band minter — every
 * cadence: daily, fixed-weekday, rolling-retrospective, one-shot, cyclic,
 * PRN), reconstructs the ONE dose-history ledger
 * (`reconstructDoseHistory`), and tallies it so the percentage and the
 * history view are mathematically incapable of contradicting each other
 * (audit CRITICAL-2). It replaces the ±12h `pairDoses` proximity matcher
 * that `calculateCompliance` used for the engine-routed path.
 *
 * The tally follows the adherence literature's TAKING-vs-TIMING split:
 *   - numerator (taken) = `taken_on_time` + `taken_late` — a late dose is
 *     still a taken dose; "late" is NOT collapsed into "missed";
 *   - denominator = taken + `missed`;
 *   - EXCLUDED from the denominator: `skipped` (deliberate user decision),
 *     `ad_hoc` (off-schedule top-up — no defensible slot), `upcoming` (the
 *     window hasn't opened), and ENTIRE PRN groups (`hasExpectedSlots:false`
 *     — PRN has no defensible denominator per the literature);
 *   - the rate is capped at 100% (extra doses never inflate it).
 *
 * The on-time / late split is surfaced separately so a caller can show both
 * the TAKING rate (the headline) and the TIMING quality.
 *
 * Pure / synchronous: the bands are minted from pre-fetched schedules +
 * intake instants; no DB access.
 */
export interface LedgerComplianceTally {
  /** Doses taken (on-time + late). The TAKING-adherence numerator. */
  taken: number;
  /** Of `taken`, the count inside the on-time band. */
  takenOnTime: number;
  /** Of `taken`, the count in the late tail (still counts as taken). */
  takenLate: number;
  /** Expected doses never acted on past their miss cutoff. */
  missed: number;
  /** Deliberate user skips — excluded from the denominator. */
  skipped: number;
  /** Off-schedule intakes (PRN groups + ad-hoc rows) — excluded. */
  adHoc: number;
  /** taken + missed (the rate denominator). */
  denominator: number;
  /** round(100 · taken / denominator), capped at 100. 100 on empty. */
  rate: number;
}

export function tallyComplianceFromLedger(
  events: IntakeEvent[],
  schedules: ComplianceSchedule[],
  ctx: ComplianceMedicationContext,
  from: Date,
  to: Date,
  now: Date,
  windowConfig?: DoseWindowConfig,
): LedgerComplianceTally {
  const rows = buildComplianceLedgerRows(
    events,
    schedules,
    ctx,
    from,
    to,
    now,
    windowConfig,
  );
  return tallyLedgerRows(rows);
}

/**
 * Mint the cadence-aware bands over `[from, to]` and reconstruct the ONE
 * unified dose-history ledger for them. This is the expansion pass behind
 * {@link tallyComplianceFromLedger}, extracted so a caller that needs
 * several trailing sub-windows (7-day / 30-day / display / heatmap, all
 * ending at `now`) can mint the bands ONCE over the widest window and tally
 * each sub-window from the same rows via {@link tallyLedgerRows} instead of
 * re-expanding per window.
 *
 * Pure / synchronous: bands come from pre-fetched schedules + intake
 * instants; no DB access.
 */
export function buildComplianceLedgerRows(
  events: IntakeEvent[],
  schedules: ComplianceSchedule[],
  ctx: ComplianceMedicationContext,
  from: Date,
  to: Date,
  now: Date,
  windowConfig?: DoseWindowConfig,
): DoseHistoryRow[] {
  const medication: BandMinterMedication = {
    id: "compliance-tally",
    startsOn: ctx.startsOn,
    endsOn: ctx.endsOn,
    oneShot: ctx.oneShot,
    createdAt: ctx.createdAt,
  };
  const recurrenceCtx = toRecurrenceCtx(ctx, "compliance-tally");
  const canonicalSchedules = schedules.map((s, i) => {
    const canonical = toCanonicalSchedule(s, `compliance-tally-${i}`);
    // A legacy daily schedule carries only `windowStart` (no `timesOfDay`,
    // no rrule, no rolling, no `daysOfWeek`). The engine's `expandLegacy`
    // reads that as "every day at windowStart", but the band minter's
    // cadence-detection gate needs an explicit time signal — surface
    // `windowStart` as the single time-of-day so the daily band is minted.
    if (
      canonical.timesOfDay.length === 0 &&
      canonical.rrule === null &&
      canonical.rollingIntervalDays === null &&
      canonical.scheduleType !== "PRN" &&
      !ctx.oneShot
    ) {
      return { ...canonical, timesOfDay: [canonical.windowStart] };
    }
    return canonical;
  });
  // Rolling cadences anchor their retrospective grid AT each logged intake;
  // the bands need every non-skipped take in (or before) the window. Reuse
  // the same instant-extraction the legacy rolling path uses so the
  // numerator and denominator are built from one expansion.
  const intakeInstants = intakeInstantsAtOrBefore(
    events.map((e) => ({ takenAt: e.takenAt, skipped: e.skipped })),
    to,
  );

  // v1.16.3 — era-aware mint: archived eras band with THEIR schedules.
  const groups = buildBandsForSchedulesWithEras({
    medication,
    schedules: canonicalSchedules,
    revisions: ctx.scheduleRevisions ?? [],
    ctx: recurrenceCtx,
    userTz: ctx.timeZone,
    range: { from, to },
    now,
    windowConfig,
    intakeInstants,
  });

  // The ledger reads `scheduledFor` + `takenAt` + skip/auto-miss flags. The
  // bands already partition the slot space, so the union of every
  // non-PRN schedule's bands is fed to ONE reconstruction — `reconstruct
  // DoseHistory` claims each slot by at most one intake, so pooling the
  // (already correctly-minted) bands is safe. PRN groups (no expected
  // slots) contribute no bands; their intakes surface as ad-hoc and are
  // excluded from the denominator, exactly as the literature requires.
  const bands: SlotBand[] = [];
  for (const g of groups) {
    if (g.hasExpectedSlots) bands.push(...g.bands);
  }

  const intakes: HistoryIntake[] = events
    .filter((e) => e.scheduledFor >= from && e.scheduledFor <= to)
    .map((e) => ({
      scheduledFor: e.scheduledFor,
      takenAt: e.takenAt,
      skipped: e.skipped,
      autoMissed: e.autoMissed ?? false,
      // v1.15.20 — a pinned take binds by anchor and tallies as taken-late
      // (slot served, no on-time gain) instead of ad_hoc + missed.
      pinned: e.attributionSource === "USER_PIN",
    }));

  const rows = reconstructDoseHistory(bands, intakes, now);

  // v1.25 H-MED1 — drop expected dose slots whose anchor falls inside a
  // pause interval. While a medication is paused no dose is expected, so a
  // slot minted across the paused window must never count as "missed" (the
  // denominator-inflating status). Only `slot` rows are dropped, and only
  // those whose status feeds the tally (taken / missed) — skip / ad-hoc /
  // upcoming rows are already excluded from the denominator, so dropping
  // them here would be a redundant double-exclusion. An open era
  // (`resumedAt === null`) runs to `now`.
  const pauseEras = ctx.pauseEras;
  if (pauseEras && pauseEras.length > 0) {
    const isInPause = (at: Date): boolean => {
      const t = at.getTime();
      for (const era of pauseEras) {
        const start = era.pausedAt.getTime();
        const end = (era.resumedAt ?? now).getTime();
        if (t >= start && t < end) return true;
      }
      return false;
    };
    return rows.filter((row) => {
      if (row.kind !== "slot") return true;
      if (
        row.status !== "taken_on_time" &&
        row.status !== "taken_late" &&
        row.status !== "missed"
      ) {
        return true;
      }
      return !isInPause(row.at);
    });
  }

  return rows;
}

/**
 * Tally pre-built ledger rows into the {@link LedgerComplianceTally}
 * counters. When `window` is supplied only rows whose instant (`row.at`)
 * falls inside `[window.from, window.to]` (inclusive) are counted — that is
 * how a sub-window tally is carved out of a wider single-pass ledger. The
 * window-less call tallies every row, byte-identical to the historical
 * {@link tallyComplianceFromLedger} behaviour.
 */
export function tallyLedgerRows(
  rows: DoseHistoryRow[],
  window?: { from: Date; to: Date },
): LedgerComplianceTally {
  let takenOnTime = 0;
  let takenLate = 0;
  let missed = 0;
  let skipped = 0;
  let adHoc = 0;
  for (const row of rows) {
    if (window) {
      const t = row.at.getTime();
      if (t < window.from.getTime() || t > window.to.getTime()) continue;
    }
    switch (row.status) {
      case "taken_on_time":
        takenOnTime++;
        break;
      case "taken_late":
        takenLate++;
        break;
      case "missed":
        missed++;
        break;
      case "skipped":
        skipped++;
        break;
      case "ad_hoc":
        adHoc++;
        break;
      // `upcoming` slots are future / still-takeable → excluded from every
      // counter so a partial head-of-window day never pollutes the rate.
    }
  }

  const taken = takenOnTime + takenLate;
  const denominator = taken + missed;
  const rate =
    denominator > 0
      ? Math.min(100, Math.round((taken / denominator) * 100))
      : 100;

  return {
    taken,
    takenOnTime,
    takenLate,
    missed,
    skipped,
    adHoc,
    denominator,
    rate,
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

  // v1.15.18 — when a medication context is supplied, the count fields
  // (taken / skipped / missed / rate) come from the UNIFIED dose-history
  // ledger tally, NOT the ±12h `pairDoses` proximity matcher. This is the
  // keystone unification: the percentage is a tally over the exact same
  // ledger the history view renders, so the two can never contradict (a
  // dose can't read "taken late" in the % while the ledger calls it
  // "ad-hoc"). The numerator is on-time + late takes (a late dose still
  // counts as taken); user skips + ad-hoc top-ups + PRN groups are excluded
  // from the denominator. The streak still walks the cadence timeline below
  // (its day-grain "every dose taken or skipped" rule is unchanged).
  //
  // Context-less callers (pure-math fixtures, pre-v1.7 surfaces) keep the
  // legacy timeline tally byte-stable — they have no engine context to mint
  // bands from.
  const ledgerCtx = options?.medicationContext;
  let ledgerCounts: {
    taken: number;
    skipped: number;
    missed: number;
    rate: number;
  } | null = null;
  if (ledgerCtx) {
    const tally = tallyComplianceFromLedger(
      events,
      schedules,
      ledgerCtx,
      effectiveStart,
      now,
      now,
    );
    ledgerCounts = {
      taken: tally.taken,
      skipped: tally.skipped,
      missed: tally.missed,
      rate: tally.rate,
    };
  }

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
        scheduleRevisions: ctx.scheduleRevisions,
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

  // v1.15.18 — the count fields come from the unified ledger tally when a
  // medication context was supplied (the keystone unification), and from the
  // legacy timeline tally otherwise (context-less pure-math callers). The
  // streak below always walks the timeline — its day-grain rule is orthogonal
  // to the per-dose attribution and stays byte-stable for every caller.
  let taken: number;
  let skipped: number;
  let missed: number;
  let rate: number;
  if (ledgerCounts) {
    ({ taken, skipped, missed, rate } = ledgerCounts);
  } else {
    taken = 0;
    skipped = 0;
    missed = 0;
    for (const slot of timeline) {
      if (slot.status === "taken") taken++;
      else if (slot.status === "skipped") skipped++;
      else if (slot.status === "missed") missed++;
      // `upcoming` slots (future window) are excluded from every counter
      // so a partial day at the head of the window doesn't pollute the rate.
    }
    // Skipped doses are excluded from the denominator — they represent a
    // deliberate user decision rather than a missed dose.
    const denom = taken + missed;
    rate = denom > 0 ? Math.min(100, Math.round((taken / denom) * 100)) : 100;
  }

  const totalExpected = taken + skipped + missed;

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

/**
 * Widest trailing window the single-pass compliance ledger has to cover:
 * the top rung of {@link COMPLIANCE_WINDOW_LADDER} (365 days). Every
 * sub-window the per-medication compliance endpoint serves (7 / 30 /
 * cadence-scaled display rows / 90-day heatmap) is a suffix of it.
 */
export const COMPLIANCE_LEDGER_WINDOW_DAYS = 365;

/**
 * The per-medication compliance payload computed from ONE shared expansion
 * pass. `ledgerRows` is the unified dose-history ledger over
 * `[ledgerFrom, now]`; the caller carves the 90-day heatmap out of it by
 * filtering on `row.at`.
 */
export interface MedicationComplianceBundle {
  compliance7: ComplianceResult;
  compliance30: ComplianceResult;
  complianceDisplay: ComplianceDisplay;
  /** Unified ledger rows over `[ledgerFrom, now]`, chronological. */
  ledgerRows: DoseHistoryRow[];
  /** Lower bound of the mint window (clamped to the medication's creation). */
  ledgerFrom: Date;
}

/**
 * Build every block of the per-medication compliance response from a single
 * band-expansion pass.
 *
 * The historical composition called {@link calculateCompliance} four times
 * (7 / 30 / short / long), {@link selectComplianceWindows} (up to four more
 * occurrence expansions for the rung probes) and a separate 90-day heatmap
 * mint — five-plus full band expansions per request. This builder instead:
 *
 *   1. mints the bands + reconstructs the ledger ONCE over
 *      `[max(createdAt, now − 365 d), now]` (every served window is a
 *      suffix of that range and ends at `now`, so a sub-window tally is a
 *      filter over `row.at`, not a re-expansion);
 *   2. builds ONE cadence timeline over the same range for the per-window
 *      streaks ({@link streaksFromTimeline} bounds its day-walk by the
 *      requested window, so the wider timeline serves every window);
 *   3. walks the {@link COMPLIANCE_WINDOW_LADDER} on the ledger's slot-row
 *      counts (one band per engine occurrence, so the counts match the
 *      historical `expectedSlotsBetween` probes).
 *
 * The returned blocks carry the exact public shapes the route has always
 * served — only the number of expansion passes changed.
 */
export function buildMedicationComplianceBundle(
  events: IntakeEvent[],
  schedules: ComplianceSchedule[],
  ctx: ComplianceMedicationContext,
  now: Date,
): MedicationComplianceBundle {
  const ledgerPeriodStart = new Date(
    now.getTime() - COMPLIANCE_LEDGER_WINDOW_DAYS * ONE_DAY_MS,
  );
  const ledgerFrom =
    ctx.createdAt.getTime() > ledgerPeriodStart.getTime()
      ? ctx.createdAt
      : ledgerPeriodStart;

  const hasSchedules = schedules.length > 0;
  const ledgerRows = hasSchedules
    ? buildComplianceLedgerRows(events, schedules, ctx, ledgerFrom, now, now)
    : [];

  // ONE cadence timeline over the full ledger window. Each per-window
  // streak below walks only its own trailing `effectiveDays`, so sharing
  // the wide timeline reproduces the per-window builds.
  const fullDays = Math.max(
    1,
    Math.ceil((now.getTime() - ledgerFrom.getTime()) / ONE_DAY_MS),
  );
  const timeline = hasSchedules
    ? buildTimelineForWindow(events, schedules, ctx, now, ledgerFrom, fullDays)
    : [];

  const resultForWindow = (days: number): ComplianceResult => {
    if (!hasSchedules) {
      // Mirrors `calculateCompliance`'s empty-schedule short-circuit.
      return {
        totalExpected: 0,
        taken: 0,
        skipped: 0,
        missed: 0,
        rate: 100,
        streak: 0,
      };
    }
    const periodStart = new Date(now.getTime() - days * ONE_DAY_MS);
    const effectiveStart =
      ctx.createdAt.getTime() > periodStart.getTime()
        ? ctx.createdAt
        : periodStart;
    const effectiveDays = Math.max(
      1,
      Math.ceil((now.getTime() - effectiveStart.getTime()) / ONE_DAY_MS),
    );
    const tally = tallyLedgerRows(ledgerRows, {
      from: effectiveStart,
      to: now,
    });
    const { current: streak } = streaksFromTimeline(
      timeline,
      now,
      effectiveDays,
      ctx.timeZone,
    );
    return {
      totalExpected: tally.taken + tally.skipped + tally.missed,
      taken: tally.taken,
      skipped: tally.skipped,
      missed: tally.missed,
      rate: tally.rate,
      streak,
    };
  };

  // Window-ladder selection from the ledger's slot rows. A slot row is one
  // minted band, and the minter emits one band per engine occurrence, so
  // counting slot rows over a trailing window equals the historical
  // `expectedSlotsBetween(...).length` probe for that window.
  const expectedCache = new Map<number, number>();
  const expectedOver = (days: number): number => {
    const hit = expectedCache.get(days);
    if (hit !== undefined) return hit;
    const from = Math.max(
      ctx.createdAt.getTime(),
      now.getTime() - days * ONE_DAY_MS,
    );
    let count = 0;
    for (const row of ledgerRows) {
      if (row.kind !== "slot") continue;
      const t = row.at.getTime();
      if (t >= from && t <= now.getTime()) count++;
    }
    expectedCache.set(days, count);
    return count;
  };

  let selection: ComplianceWindowSelection | null = null;
  for (const [shortDays, longDays] of COMPLIANCE_WINDOW_LADDER) {
    const expectedShort = expectedOver(shortDays);
    const expectedLong = expectedOver(longDays);
    if (expectedShort >= MIN_STABLE_DOSES && expectedLong >= MIN_STABLE_DOSES) {
      selection = { shortDays, longDays, expectedShort, expectedLong };
      break;
    }
  }
  if (!selection) {
    // No rung cleared the floor — fall back to the widest rung, exactly
    // like `selectComplianceWindows`.
    const [shortDays, longDays] =
      COMPLIANCE_WINDOW_LADDER[COMPLIANCE_WINDOW_LADDER.length - 1];
    selection = {
      shortDays,
      longDays,
      expectedShort: expectedOver(shortDays),
      expectedLong: expectedOver(longDays),
    };
  }

  const compliance7 = resultForWindow(7);
  const compliance30 = resultForWindow(30);
  const short = resultForWindow(selection.shortDays);
  const long = resultForWindow(selection.longDays);

  const currentCycle = buildCurrentCycle(
    schedules,
    ctx,
    now,
    selection.expectedShort,
    events,
  );
  const currentDose: { status: DoseStatus; targetAt: Date | null } =
    currentCycle.nextDueAt
      ? {
          status: deriveDoseStatus(
            currentCycle.nextDueAt,
            soonestCadenceFamily(schedules),
            now,
          ),
          targetAt: currentCycle.nextDueAt,
        }
      : { status: "upcoming", targetAt: null };

  const complianceDisplay: ComplianceDisplay = {
    shortDays: selection.shortDays,
    longDays: selection.longDays,
    expectedShort: selection.expectedShort,
    expectedLong: selection.expectedLong,
    minStableDoses: MIN_STABLE_DOSES,
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
    currentDose,
  };

  return {
    compliance7,
    compliance30,
    complianceDisplay,
    ledgerRows,
    ledgerFrom,
  };
}

/**
 * One day of the cadence-aware compliance series: the day's compliance %
 * over the doses the schedule actually expected that day, plus the raw
 * taken / missed counts behind it.
 */
export interface DailyComplianceRate {
  /** The day's anchor instant (the first expected slot of the day). */
  date: Date;
  /** round(100 · taken / (taken + missed)), capped at 100. */
  rate: number;
  /** Doses taken (on-time + late) on the day. */
  taken: number;
  /** Expected doses never acted on past their miss cutoff, on the day. */
  missed: number;
}

/**
 * v1.18.0 — collapse unified dose-history ledger rows into a cadence-aware
 * per-day compliance series.
 *
 * Only days the schedule's cadence actually expected a dose produce a point:
 * the series is grouped over the ledger's scheduled `slot` rows, so an
 * off-cadence weekday (a weekly Monday-only med on a Tuesday) or an off-week
 * (the off-week of a bi-weekly schedule) emits no point at all and therefore
 * can never be read as a 0% "miss". Each day's rate uses the SAME
 * taken / (taken + missed) tally — and the SAME on-time-plus-late numerator,
 * skip / ad-hoc / upcoming exclusions — that {@link tallyLedgerRows} applies
 * to `compliance7` / `compliance30`, so the per-day series and the window
 * rates are computed from one ledger and cannot contradict each other.
 *
 * `ad_hoc` rows (off-schedule top-ups, no defensible slot) and `upcoming`
 * rows (the window hasn't opened) are dropped before grouping, exactly as the
 * window tally excludes them. A day whose only ledger rows are skips yields no
 * point (zero denominator) rather than a misleading 0%.
 */
export function dailyComplianceRatesFromLedger(
  ledgerRows: DoseHistoryRow[],
): DailyComplianceRate[] {
  const byDay = new Map<
    string,
    { taken: number; missed: number; date: Date }
  >();

  for (const row of ledgerRows) {
    // Only scheduled slots have a defensible denominator; ad-hoc top-ups are
    // excluded from the rate exactly as `tallyLedgerRows` excludes them.
    if (row.kind !== "slot") continue;
    const isTaken =
      row.status === "taken_on_time" || row.status === "taken_late";
    const isMissed = row.status === "missed";
    // `skipped` (deliberate) and `upcoming` (window not open) advance neither
    // counter — they never enter the day's denominator.
    if (!isTaken && !isMissed) continue;

    const dayKey = toBerlinDayKey(row.at);
    const bucket = byDay.get(dayKey) ?? { taken: 0, missed: 0, date: row.at };
    if (isTaken) bucket.taken += 1;
    else bucket.missed += 1;
    // Keep the earliest slot instant of the day as the point's anchor.
    if (row.at.getTime() < bucket.date.getTime()) bucket.date = row.at;
    byDay.set(dayKey, bucket);
  }

  return Array.from(byDay.values())
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((day) => {
      const denom = day.taken + day.missed;
      return {
        date: day.date,
        rate:
          denom > 0
            ? Math.min(100, Math.round((day.taken / denom) * 100))
            : 100,
        taken: day.taken,
        missed: day.missed,
      };
    });
}

/**
 * The cadence-timeline construction from {@link calculateCompliance},
 * extracted so {@link buildMedicationComplianceBundle} can build it once
 * over the full ledger window instead of once per served sub-window. Same
 * normalisation, same engine context, same rolling-retrospective routing.
 */
function buildTimelineForWindow(
  events: IntakeEvent[],
  schedules: ComplianceSchedule[],
  ctx: ComplianceMedicationContext,
  now: Date,
  effectiveStart: Date,
  effectiveDays: number,
): ReturnType<typeof buildCadenceTimeline> {
  const normalisedSchedules: ScheduleLike[] = schedules.map((s, i) => ({
    id: `compliance-${i}`,
    windowStart: s.windowStart,
    windowEnd: s.windowEnd,
    daysOfWeek: s.daysOfWeek ?? null,
    rrule: s.rrule ?? null,
    rollingIntervalDays: s.rollingIntervalDays ?? null,
    timesOfDay: s.timesOfDay,
    reminderGraceMinutes: s.reminderGraceMinutes ?? null,
    scheduleType: s.scheduleType ?? null,
    cyclicOnWeeks: s.cyclicOnWeeks ?? null,
    cyclicOffWeeks: s.cyclicOffWeeks ?? null,
  }));

  const engineCtx: CadenceEngineContext = {
    startsOn: ctx.startsOn,
    endsOn: ctx.endsOn,
    oneShot: ctx.oneShot,
    createdAt: ctx.createdAt,
    lastIntakeAt: ctx.lastIntakeAt,
    timeZone: ctx.timeZone,
    scheduleRevisions: ctx.scheduleRevisions,
  };

  const normalisedEvents: IntakeEventLike[] = events
    .filter((e) => e.scheduledFor >= effectiveStart && e.scheduledFor <= now)
    .map((e) => ({
      scheduledFor: e.scheduledFor,
      takenAt: e.takenAt,
      skipped: e.skipped,
      autoMissed: e.autoMissed ?? false,
    }));

  const hasRolling = schedules.some(
    (s) => s.rollingIntervalDays != null && s.rollingIntervalDays > 0,
  );
  const retro = hasRolling
    ? { intakeInstants: rollingIntakeInstants(events, now), now }
    : undefined;

  return buildCadenceTimeline(
    normalisedSchedules,
    normalisedEvents,
    now,
    effectiveDays,
    ctx.createdAt,
    ctx.timeZone,
    engineCtx,
    retro,
  );
}
