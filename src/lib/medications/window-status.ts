/**
 * v1.4.37 W4b — shared current-window status helper for medication
 * detail cards.
 *
 * Both the generic `<MedicationCard>` and the GLP-1 variant
 * (`<Glp1MedicationCard>`) need to paint the same coloured "take now /
 * overdue / very overdue" pill at the top of their detail surface. The
 * logic was historically inlined in the generic card only, which produced
 * a visible asymmetry between the two variants (v1.4.37 UX audit item 11).
 *
 * Lifting the schedule-window math into one helper guarantees both card
 * variants stay byte-equivalent for the status row — same thresholds,
 * same in-window / late / very-late tiering, same overnight-window
 * handling, same "don't show in-window if last intake already covered
 * this window today" guard. The GLP-1 schedule shape carries the same
 * `windowStart` / `windowEnd` / `daysOfWeek` fields as the generic
 * schedule, so the helper accepts any schedule that satisfies the
 * minimal `ScheduleWindowInput` shape.
 *
 * v1.15.20 — three model fixes:
 *   - the wall-clock conversion takes the user's IANA timezone (default
 *     `Europe/Berlin` so existing call sites compile + behave unchanged;
 *     threading the real user timezone through the cards is the follow-up);
 *   - a degenerate `windowStart === windowEnd` schedule (a single dose
 *     time echoed into both fields) is a POINT window widened by the
 *     default daily on-time half-width — it previously fell into the
 *     overnight branch and read as a 24 h always-in-window band;
 *   - `countPassedSchedules` counts the schedule's `timesOfDay` doses, not
 *     schedule rows, so a two-dose row ("08:00" + "20:00") expects two
 *     intake events before the overdue pill is suppressed.
 */
import { parseScheduleRecurrence } from "@/lib/medication-schedule";
import { DOSE_WINDOW_DEFAULTS } from "@/lib/medications/scheduling/dose-window-defaults";

export interface ScheduleWindowInput {
  windowStart: string;
  windowEnd: string;
  daysOfWeek: string | null;
  /**
   * v1.15.20 — first-class dose times. Optional so legacy fixtures and the
   * existing card call sites compile unchanged; when absent the schedule
   * row counts as ONE expected dose (the pre-v1.15.20 behaviour).
   */
  timesOfDay?: string[];
}

export type MedicationWindowStatus = "in_window" | "late" | "very_late" | null;

export interface CurrentWindowStatus<Schedule extends ScheduleWindowInput> {
  status: MedicationWindowStatus;
  schedule: Schedule | null;
}

/** Fallback timezone until every call site threads the user's own. */
const DEFAULT_TZ = "Europe/Berlin";

/**
 * Convert a `Date` from its underlying UTC instant into the wall-clock
 * value in the given IANA timezone so the per-minute arithmetic below
 * treats the user's day boundary correctly. Intentionally en-US — this is
 * not a user-facing format string, only a parseable round-trip to shift
 * the value into the target local time.
 */
export function toZonedDate(date: Date, tz: string = DEFAULT_TZ): Date {
  return new Date(date.toLocaleString("en-US", { timeZone: tz }));
}

/**
 * Legacy alias kept for the existing card call sites; new code should call
 * `toZonedDate(date, userTz)` with the user's real timezone.
 */
export function toBerlinDate(date: Date): Date {
  return toZonedDate(date, DEFAULT_TZ);
}

export function parseTimeToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  if (
    !Number.isFinite(h) ||
    !Number.isFinite(m) ||
    h < 0 ||
    h > 23 ||
    m < 0 ||
    m > 59
  ) {
    return 0;
  }
  return h * 60 + m;
}

interface WindowBounds {
  startMins: number;
  /** May exceed 24 h × 60 for an overnight window (end wrapped past midnight). */
  endMins: number;
}

/**
 * Resolve a schedule's window into minute-of-day bounds with two special
 * shapes handled:
 *
 *   - `end === start` — a degenerate POINT window (a single dose time echoed
 *     into both fields). Previously this fell into the overnight branch and
 *     became a 24 h always-in-window band; it now widens symmetrically by
 *     the default daily on-time half-width, clamped to the same local day
 *     so the overnight arithmetic downstream stays untouched.
 *   - `end < start` — a genuine overnight window; the end wraps past
 *     midnight (`endMins > 1440`), matching the historical behaviour.
 */
function resolveWindowBounds(schedule: ScheduleWindowInput): WindowBounds {
  let startMins = parseTimeToMinutes(schedule.windowStart);
  let endMins = parseTimeToMinutes(schedule.windowEnd);

  if (endMins === startMins) {
    const half = DOSE_WINDOW_DEFAULTS.dailyOnTimeMinutes;
    startMins = Math.max(0, startMins - half);
    endMins = Math.min(24 * 60 - 1, endMins + half);
  } else if (endMins < startMins) {
    endMins += 24 * 60;
  }

  return { startMins, endMins };
}

function getWindowStatus<Schedule extends ScheduleWindowInput>(
  schedule: Schedule,
  nowLocal: Date,
  lateMinutes: number,
  missedMinutes: number,
): MedicationWindowStatus {
  const nowMins = nowLocal.getHours() * 60 + nowLocal.getMinutes();
  const { startMins, endMins } = resolveWindowBounds(schedule);

  // Handle overnight windows
  const adjustedNow =
    nowMins < startMins && endMins > 24 * 60 ? nowMins + 24 * 60 : nowMins;

  // Currently in window
  if (adjustedNow >= startMins && adjustedNow <= endMins) return "in_window";

  // Past window end: check late thresholds
  const minutesPastEnd = adjustedNow - endMins;
  if (minutesPastEnd > 0 && minutesPastEnd <= lateMinutes) return "late";
  if (minutesPastEnd > lateMinutes && minutesPastEnd <= missedMinutes)
    return "very_late";

  return null;
}

function isLastIntakeInCurrentWindow<Schedule extends ScheduleWindowInput>(
  lastTakenAt: string | null,
  schedule: Schedule,
  nowLocal: Date,
  tz: string,
): boolean {
  if (!lastTakenAt) return false;

  const intake = toZonedDate(new Date(lastTakenAt), tz);

  // Must be same calendar day
  if (
    intake.getFullYear() !== nowLocal.getFullYear() ||
    intake.getMonth() !== nowLocal.getMonth() ||
    intake.getDate() !== nowLocal.getDate()
  ) {
    return false;
  }

  const intakeMins = intake.getHours() * 60 + intake.getMinutes();
  const { startMins, endMins } = resolveWindowBounds(schedule);

  // Handle overnight windows
  const adjustedIntake =
    intakeMins < startMins && endMins > 24 * 60
      ? intakeMins + 24 * 60
      : intakeMins;

  return adjustedIntake >= startMins && adjustedIntake <= endMins;
}

/**
 * Count how many doses are past their window today, honouring the
 * recurrence's allowed days-of-week. Used by both cards to suppress
 * "overdue" pills once the user has already covered every passed dose
 * with intake events for the day.
 *
 * v1.15.20 — counts `timesOfDay` entries, not schedule rows: a schedule
 * row carrying two dose times expects TWO intake events once its window
 * passes. A row without `timesOfDay` (legacy shape) keeps counting as one.
 * The passed check stays anchored on the (degenerate-resolved) raw window
 * end of the same local day, matching the historical comparison — an
 * overnight window therefore never reads as "passed" within the same local
 * day, exactly as before.
 */
function countPassedSchedules<Schedule extends ScheduleWindowInput>(
  schedules: Schedule[],
  nowLocal: Date,
): number {
  return schedules.reduce((sum, s) => {
    const recurrence = parseScheduleRecurrence(s.daysOfWeek);
    if (
      recurrence.daysOfWeek.length > 0 &&
      !recurrence.daysOfWeek.includes(nowLocal.getDay())
    ) {
      return sum;
    }
    // Same-day end bound: a wrapped overnight end (> 1440) keeps the raw
    // minute value so the comparison below matches the historical
    // behaviour; the degenerate point window resolves to its widened end.
    const rawStart = parseTimeToMinutes(s.windowStart);
    const rawEnd = parseTimeToMinutes(s.windowEnd);
    const endMins =
      rawEnd === rawStart
        ? Math.min(24 * 60 - 1, rawEnd + DOSE_WINDOW_DEFAULTS.dailyOnTimeMinutes)
        : rawEnd;
    const nowMins = nowLocal.getHours() * 60 + nowLocal.getMinutes();
    if (nowMins <= endMins) return sum;
    const doseCount =
      s.timesOfDay && s.timesOfDay.length > 0 ? s.timesOfDay.length : 1;
    return sum + doseCount;
  }, 0);
}

/**
 * Reduce a list of schedules into the most actionable window status
 * for the card header pill. Returns `null` status when the medication
 * is paused, no schedule is currently in/past its window, or every
 * overdue schedule is already covered by today's intake events.
 *
 * Priority: in_window > late > very_late. Suppresses an `in_window`
 * status when the last intake already falls inside the window so the
 * pill doesn't nag after the user took the dose.
 *
 * `nowBerlin` is the wall-clock "now" already shifted into the user's
 * timezone (via `toZonedDate`); `tz` must name the same timezone so the
 * last-intake comparison shifts `lastTakenAt` identically. The name and
 * the default are the legacy Berlin contract — callers that serve other
 * timezones pass their own.
 */
export function reduceCurrentWindowStatus<Schedule extends ScheduleWindowInput>(
  options: {
    schedules: Schedule[];
    nowBerlin: Date;
    lateMinutes: number;
    missedMinutes: number;
    active: boolean;
    lastTakenAt: string | null;
    todayEventCount: number;
    /** IANA timezone matching `nowBerlin`'s conversion; defaults to Berlin. */
    tz?: string;
  },
): CurrentWindowStatus<Schedule> {
  const {
    schedules,
    nowBerlin,
    lateMinutes,
    missedMinutes,
    active,
    lastTakenAt,
    todayEventCount,
    tz = DEFAULT_TZ,
  } = options;

  if (!active) return { status: null, schedule: null };

  const passedScheduleCount = countPassedSchedules(schedules, nowBerlin);
  const hasUncoveredOverdue = todayEventCount < passedScheduleCount;

  return schedules.reduce<CurrentWindowStatus<Schedule>>(
    (best, s) => {
      const status = getWindowStatus(s, nowBerlin, lateMinutes, missedMinutes);
      if (!status) return best;
      // Don't show late/very_late if all overdue schedules are covered
      // by intake events for the day.
      if (status !== "in_window" && !hasUncoveredOverdue) return best;
      // Don't show in_window if last intake is already within this
      // window today.
      if (
        status === "in_window" &&
        isLastIntakeInCurrentWindow(lastTakenAt, s, nowBerlin, tz)
      ) {
        return best;
      }
      const priority = { in_window: 3, late: 2, very_late: 1 };
      if (!best.status || priority[status] > priority[best.status]) {
        return { status, schedule: s };
      }
      return best;
    },
    { status: null, schedule: null },
  );
}
