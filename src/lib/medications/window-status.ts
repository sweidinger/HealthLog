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
 * v1.16.1 — the dose-band model becomes the canonical source. When a
 * schedule carries `timesOfDay`, every status decision derives from
 * per-dose on-time bands — the explicit `doseWindows` entry for the
 * matching dose when present, else `timeOfDay ±` the default daily
 * on-time half-width. The legacy `windowStart` / `windowEnd` pair is
 * consulted ONLY for rows without `timesOfDay`; a stale or degenerate
 * window (e.g. `07:00 / 07:00` left behind by an old write path while
 * the times moved to `09:00 / 21:00`) can no longer paint a take-now
 * pill at 07:00 or mis-anchor the recorded slot. The matched band rides
 * on the result (`window`) so the pill text and the displayed-slot
 * resolution read the SAME band the status came from.
 *
 * v1.15.20 — three model fixes (kept):
 *   - the wall-clock conversion takes the user's IANA timezone (default
 *     `Europe/Berlin` so existing call sites compile + behave unchanged;
 *     threading the real user timezone through the cards is the follow-up);
 *   - a degenerate `windowStart === windowEnd` schedule (a single dose
 *     time echoed into both fields) is a POINT window widened by the
 *     default daily on-time half-width — it previously fell into the
 *     overnight branch and read as a 24 h always-in-window band;
 *   - passed-dose counting counts the schedule's `timesOfDay` doses, not
 *     schedule rows, so a two-dose row ("08:00" + "20:00") expects two
 *     intake events before the overdue pill is suppressed.
 */
import { parseScheduleRecurrence } from "@/lib/medication-schedule";
import { DOSE_WINDOW_DEFAULTS } from "@/lib/medications/scheduling/dose-window-defaults";

/** One explicit per-dose on-time window as the API serialises it. */
export interface DoseWindowEntryInput {
  timeOfDay: string;
  start: string;
  end: string;
}

export interface ScheduleWindowInput {
  windowStart: string;
  windowEnd: string;
  daysOfWeek: string | null;
  /**
   * v1.15.20 — first-class dose times. Optional so legacy fixtures and the
   * existing card call sites compile unchanged; when absent the schedule
   * row falls back to the single legacy window (the pre-v1.16.1 behaviour).
   */
  timesOfDay?: string[];
  /**
   * v1.16.1 — explicit per-dose on-time windows (the detail page's
   * Zeitplan editor writes them). Only read for doses listed in
   * `timesOfDay`; malformed entries fall back to the default derivation.
   */
  doseWindows?: DoseWindowEntryInput[] | null;
}

export type MedicationWindowStatus = "in_window" | "late" | "very_late" | null;

/**
 * The dose band that produced a non-null status. `timeOfDay` is the dose
 * anchor (a `timesOfDay` entry, or `windowStart` on a legacy row); `start`
 * / `end` are the HH:mm band bounds for display.
 */
export interface MatchedDoseWindow {
  timeOfDay: string;
  start: string;
  end: string;
}

export interface CurrentWindowStatus<Schedule extends ScheduleWindowInput> {
  status: MedicationWindowStatus;
  schedule: Schedule | null;
  /** Non-null exactly when `status` is non-null. */
  window: MatchedDoseWindow | null;
}

/**
 * v1.16.6 — the server's display-due verdict (`nextDueAt` +
 * `nextDueOverdue` on the list payload, computed by `computeDisplayDue`
 * from the band model: next unresolved slot + its overdue tail). When a
 * caller threads it, the pill status is gated on it so the pill can NEVER
 * read more overdue than the next-due line. Without the gate a rolling
 * cadence (`daysOfWeek` empty) re-mints its dose band every local day and
 * escalates to late / very_late each afternoon even while the next
 * unresolved slot sits days in the future.
 */
export interface NextDueGate {
  /** The display-due instant (`nextDueAt` parsed). */
  at: Date;
  /** True when that instant is an OPEN overdue slot (`nextDueOverdue`). */
  overdue: boolean;
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

function minutesToHm(mins: number): string {
  const clamped = Math.min(Math.max(mins, 0), 24 * 60 - 1);
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

interface DoseWindowBounds {
  /** Dose anchor for slot resolution + UI labels. */
  timeOfDay: string;
  startMins: number;
  /** May exceed 24 h × 60 for a legacy overnight window (end wrapped past midnight). */
  endMins: number;
  /** HH:mm display strings (the legacy branch keeps the raw schedule strings). */
  startHm: string;
  endHm: string;
}

/**
 * Resolve a legacy (no `timesOfDay`) schedule window into minute-of-day
 * bounds with two special shapes handled:
 *
 *   - `end === start` — a degenerate POINT window (a single dose time echoed
 *     into both fields). Previously this fell into the overnight branch and
 *     became a 24 h always-in-window band; it now widens symmetrically by
 *     the default daily on-time half-width, clamped to the same local day
 *     so the overnight arithmetic downstream stays untouched.
 *   - `end < start` — a genuine overnight window; the end wraps past
 *     midnight (`endMins > 1440`), matching the historical behaviour.
 */
function resolveLegacyWindowBounds(schedule: ScheduleWindowInput): {
  startMins: number;
  endMins: number;
} {
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

/**
 * v1.16.1 — the canonical band resolution. A schedule with `timesOfDay`
 * yields ONE band per dose: the explicit `doseWindows` entry when present
 * and well-formed, else `timeOfDay ±` the default daily on-time
 * half-width (clamped to the local day). A schedule without `timesOfDay`
 * yields the single legacy window. The legacy `windowStart` / `windowEnd`
 * NEVER shape a band once `timesOfDay` exists — stale or degenerate
 * windows must not drive the status or the recorded slot.
 */
function resolveDoseWindows(schedule: ScheduleWindowInput): DoseWindowBounds[] {
  const times = (schedule.timesOfDay ?? []).filter((t) => HHMM_RE.test(t));
  if (times.length > 0) {
    const half = DOSE_WINDOW_DEFAULTS.dailyOnTimeMinutes;
    return times.map((timeOfDay) => {
      const explicit = Array.isArray(schedule.doseWindows)
        ? schedule.doseWindows.find(
            (w) =>
              w &&
              w.timeOfDay === timeOfDay &&
              HHMM_RE.test(w.start) &&
              HHMM_RE.test(w.end) &&
              parseTimeToMinutes(w.start) <= parseTimeToMinutes(w.end),
          )
        : undefined;
      if (explicit) {
        return {
          timeOfDay,
          startMins: parseTimeToMinutes(explicit.start),
          endMins: parseTimeToMinutes(explicit.end),
          startHm: explicit.start,
          endHm: explicit.end,
        };
      }
      const anchor = parseTimeToMinutes(timeOfDay);
      const startMins = Math.max(0, anchor - half);
      const endMins = Math.min(24 * 60 - 1, anchor + half);
      return {
        timeOfDay,
        startMins,
        endMins,
        startHm: minutesToHm(startMins),
        endHm: minutesToHm(endMins),
      };
    });
  }

  const { startMins, endMins } = resolveLegacyWindowBounds(schedule);
  return [
    {
      timeOfDay: schedule.windowStart,
      startMins,
      endMins,
      // Keep the raw schedule strings for display so legacy pills render
      // byte-identically to the pre-band model.
      startHm: schedule.windowStart,
      endHm: schedule.windowEnd,
    },
  ];
}

const STATUS_PRIORITY = { in_window: 3, late: 2, very_late: 1 } as const;

function bandStatus(
  band: DoseWindowBounds,
  nowMins: number,
  lateMinutes: number,
  missedMinutes: number,
): Exclude<MedicationWindowStatus, null> | null {
  // Handle legacy overnight windows (wrapped end past midnight).
  const adjustedNow =
    nowMins < band.startMins && band.endMins > 24 * 60
      ? nowMins + 24 * 60
      : nowMins;

  if (adjustedNow >= band.startMins && adjustedNow <= band.endMins) {
    return "in_window";
  }

  const minutesPastEnd = adjustedNow - band.endMins;
  if (minutesPastEnd > 0 && minutesPastEnd <= lateMinutes) return "late";
  if (minutesPastEnd > lateMinutes && minutesPastEnd <= missedMinutes) {
    return "very_late";
  }
  return null;
}

function getScheduleStatus(
  schedule: ScheduleWindowInput,
  nowLocal: Date,
  lateMinutes: number,
  missedMinutes: number,
): {
  status: Exclude<MedicationWindowStatus, null>;
  band: DoseWindowBounds;
} | null {
  const nowMins = nowLocal.getHours() * 60 + nowLocal.getMinutes();
  let best: {
    status: Exclude<MedicationWindowStatus, null>;
    band: DoseWindowBounds;
  } | null = null;
  for (const band of resolveDoseWindows(schedule)) {
    const status = bandStatus(band, nowMins, lateMinutes, missedMinutes);
    if (!status) continue;
    if (!best || STATUS_PRIORITY[status] > STATUS_PRIORITY[best.status]) {
      best = { status, band };
    }
  }
  return best;
}

function isLastIntakeInBand(
  lastTakenAt: string | null,
  band: DoseWindowBounds,
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

  // Handle legacy overnight windows
  const adjustedIntake =
    intakeMins < band.startMins && band.endMins > 24 * 60
      ? intakeMins + 24 * 60
      : intakeMins;

  return adjustedIntake >= band.startMins && adjustedIntake <= band.endMins;
}

/**
 * Count how many doses are past their band today, honouring the
 * recurrence's allowed days-of-week. Used by both cards to suppress
 * "overdue" pills once the user has already covered every passed dose
 * with intake events for the day.
 *
 * v1.16.1 — counts per-dose BANDS: each `timesOfDay` dose passes when its
 * own on-time band end has passed, so a 09:00 / 21:00 row reads ONE
 * passed dose at noon (not two). A row without `timesOfDay` (legacy
 * shape) keeps the single-window behaviour, including the degenerate
 * point-window resolution; a wrapped overnight end (> 1440) keeps the raw
 * minute comparison so an overnight window never reads as "passed"
 * within the same local day, exactly as before.
 */
function countPassedDoses<Schedule extends ScheduleWindowInput>(
  schedules: Schedule[],
  nowLocal: Date,
): number {
  const nowMins = nowLocal.getHours() * 60 + nowLocal.getMinutes();
  return schedules.reduce((sum, s) => {
    const recurrence = parseScheduleRecurrence(s.daysOfWeek);
    if (
      recurrence.daysOfWeek.length > 0 &&
      !recurrence.daysOfWeek.includes(nowLocal.getDay())
    ) {
      return sum;
    }
    const passed = resolveDoseWindows(s).filter((band) => {
      // Same-day end bound: a wrapped overnight end (> 1440) keeps the
      // raw minute value so the comparison matches the historical
      // behaviour (it never passes within the same local day).
      const endMins =
        band.endMins > 24 * 60 ? band.endMins - 24 * 60 : band.endMins;
      return nowMins > endMins;
    }).length;
    return sum + passed;
  }, 0);
}

/**
 * Reduce a list of schedules into the most actionable window status
 * for the card header pill. Returns `null` status when the medication
 * is paused, no dose band is currently in/past its window, or every
 * overdue dose is already covered by today's intake events.
 *
 * Priority: in_window > late > very_late. Suppresses an `in_window`
 * status when the last intake already falls inside the matched band so
 * the pill doesn't nag after the user took the dose.
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
    /**
     * v1.16.6 — the server display-due gate. `undefined` keeps the legacy
     * purely band-derived behaviour (callers without the list payload);
     * `null` means the server found NO upcoming slot (paused / ended /
     * one-shot past) so no pill renders at all. With a gate present:
     *   - `overdue: false` (next unresolved slot in the future) suppresses
     *     late / very_late outright and allows in_window only when the due
     *     instant falls on the current local day — a rolling cadence whose
     *     next dose is tomorrow stays calm today;
     *   - `overdue: true` keeps the band-derived escalation (the slot is
     *     genuinely in its catch-up tail).
     */
    nextDue?: NextDueGate | null;
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
    nextDue,
  } = options;

  const none: CurrentWindowStatus<Schedule> = {
    status: null,
    schedule: null,
    window: null,
  };
  if (!active) return none;
  if (nextDue === null) return none;

  const passedDoseCount = countPassedDoses(schedules, nowBerlin);
  const hasUncoveredOverdue = todayEventCount < passedDoseCount;

  // Display-due gate (see the option's doc above). Computed once: it does
  // not vary per schedule row — the server already reduced the rows to one
  // verdict.
  const dueIsToday =
    nextDue != null &&
    (() => {
      const dueLocal = toZonedDate(nextDue.at, tz);
      return (
        dueLocal.getFullYear() === nowBerlin.getFullYear() &&
        dueLocal.getMonth() === nowBerlin.getMonth() &&
        dueLocal.getDate() === nowBerlin.getDate()
      );
    })();

  return schedules.reduce<CurrentWindowStatus<Schedule>>((best, s) => {
    const hit = getScheduleStatus(s, nowBerlin, lateMinutes, missedMinutes);
    if (!hit) return best;
    // The pill must never read more overdue than the next-due line: a
    // future (non-overdue) display-due suppresses every overdue tier, and
    // allows the take-now pill only on the due day itself.
    if (nextDue != null && !nextDue.overdue) {
      if (hit.status !== "in_window") return best;
      if (!dueIsToday) return best;
    }
    // Don't show late/very_late if all overdue doses are covered by
    // intake events for the day.
    if (hit.status !== "in_window" && !hasUncoveredOverdue) return best;
    // Don't show in_window if last intake is already within this band
    // today.
    if (
      hit.status === "in_window" &&
      isLastIntakeInBand(lastTakenAt, hit.band, nowBerlin, tz)
    ) {
      return best;
    }
    if (!best.status || STATUS_PRIORITY[hit.status] > STATUS_PRIORITY[best.status]) {
      return {
        status: hit.status,
        schedule: s,
        window: {
          timeOfDay: hit.band.timeOfDay,
          start: hit.band.startHm,
          end: hit.band.endHm,
        },
      };
    }
    return best;
  }, none);
}
