/**
 * v1.4.18 — expansion metrics + earnability flags for the achievement
 * route. Pure helpers operating over typed prisma rows so the unit
 * tests can drive synthetic data without standing up a database.
 *
 * The route stitches these into the existing `metrics` object so
 * `evaluateAchievementsWithCompletionDates` evaluates the new
 * achievements with no further plumbing.
 */
import {
  calculateLongestStreak,
  toBerlinDayKey,
  type EarnabilityFlags,
} from "./achievements";

const BERLIN_TIMEZONE = "Europe/Berlin";

const BERLIN_HOUR_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: BERLIN_TIMEZONE,
  hour: "2-digit",
  hour12: false,
});

function berlinHour(date: Date): number {
  const value = BERLIN_HOUR_FORMATTER.format(date);
  // formatToParts is more reliable across runtimes — split + parseInt
  // works because the formatter uses 24-hour with no extra tokens.
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

const BERLIN_WEEKDAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: BERLIN_TIMEZONE,
  weekday: "short",
});

function berlinWeekday(date: Date): string {
  return BERLIN_WEEKDAY_FORMATTER.format(date);
}

export interface MoodEntryRecord {
  date: string; // YYYY-MM-DD (already Berlin-local in MoodEntry schema)
  score: number; // 1..5
  moodLoggedAt: Date;
}

export interface MeasurementRecord {
  type: string;
  measuredAt: Date;
}

export interface IntakeEventRecord {
  scheduledFor: Date;
  takenAt: Date | null;
  skipped: boolean;
}

export interface AuditLogRecord {
  action: string;
  createdAt: Date;
}

/**
 * Counts of measurements per type. Used both for the count-based
 * vitals achievements (weight-200 et al.) and for the discovery
 * filter (a user with zero BP measurements never sees the BP
 * progress cards).
 */
export interface MeasurementCounts {
  weightCount: number;
  bpCount: number; // counts BLOOD_PRESSURE_SYS as the canonical BP entry
  pulseCount: number;
}

export function countMeasurementsByType(
  measurements: MeasurementRecord[],
): MeasurementCounts {
  let weight = 0;
  let bp = 0;
  let pulse = 0;
  for (const m of measurements) {
    if (m.type === "WEIGHT") weight += 1;
    else if (m.type === "BLOOD_PRESSURE_SYS") bp += 1;
    else if (m.type === "PULSE") pulse += 1;
  }
  return { weightCount: weight, bpCount: bp, pulseCount: pulse };
}

/**
 * Mood metrics. The longest day-streak is computed off the unique
 * Berlin-local `date` strings already stored on `MoodEntry`. The
 * "improvement hit" is a one-shot boolean: did *any* 7-day window
 * have a mean score at least 1.0 higher than the preceding 7-day
 * window? We intentionally use the user's own baseline (no global
 * comparison) so the badge is non-coercive.
 */
export function getMoodMetrics(entries: MoodEntryRecord[]): {
  moodEntryCount: number;
  moodDayStreak: number;
  moodImprovementHit: number;
} {
  const moodEntryCount = entries.length;
  if (moodEntryCount === 0) {
    return { moodEntryCount: 0, moodDayStreak: 0, moodImprovementHit: 0 };
  }

  const dayKeys = Array.from(new Set(entries.map((e) => e.date))).sort();
  const moodDayStreak = calculateLongestStreak(dayKeys);

  // Aggregate mean score per Berlin day for the improvement check.
  const perDay = new Map<string, { sum: number; count: number }>();
  for (const e of entries) {
    const bucket = perDay.get(e.date) ?? { sum: 0, count: 0 };
    bucket.sum += e.score;
    bucket.count += 1;
    perDay.set(e.date, bucket);
  }
  const sortedDays = Array.from(perDay.entries())
    .map(([date, b]) => ({ date, mean: b.sum / b.count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  let moodImprovementHit = 0;
  // Sliding 7-day window mean compared to the preceding 7-day mean.
  // 14 distinct days minimum needed for the comparison to fire.
  for (let i = 13; i < sortedDays.length; i++) {
    const recent = sortedDays.slice(i - 6, i + 1);
    const prior = sortedDays.slice(i - 13, i - 6);
    if (recent.length < 7 || prior.length < 7) continue;
    const recentMean =
      recent.reduce((acc, d) => acc + d.mean, 0) / recent.length;
    const priorMean = prior.reduce((acc, d) => acc + d.mean, 0) / prior.length;
    if (recentMean - priorMean >= 1.0) {
      moodImprovementHit = 1;
      break;
    }
  }

  return { moodEntryCount, moodDayStreak, moodImprovementHit };
}

/**
 * "Consistent month" + entry-streak metrics. Operates on the union of
 * any data point that signals tracking activity — measurements, mood
 * entries, taken/skipped intake events. A day "counts" if it has at
 * least one entry of any kind (Berlin-local).
 */
export function getEngagementMetrics(input: {
  measurements: MeasurementRecord[];
  moodEntries: MoodEntryRecord[];
  intakeEvents: IntakeEventRecord[];
}): {
  consistentMonthCount: number;
  entryDayStreak: number;
  weekendStreakCount: number;
} {
  const allDates: Date[] = [];
  for (const m of input.measurements) allDates.push(m.measuredAt);
  for (const e of input.moodEntries) allDates.push(e.moodLoggedAt);
  for (const i of input.intakeEvents) {
    if (i.takenAt) allDates.push(i.takenAt);
    else if (i.skipped) allDates.push(i.scheduledFor);
  }

  if (allDates.length === 0) {
    return {
      consistentMonthCount: 0,
      entryDayStreak: 0,
      weekendStreakCount: 0,
    };
  }

  const uniqueDays = Array.from(
    new Set(allDates.map((d) => toBerlinDayKey(d))),
  ).sort();
  const entryDayStreak = calculateLongestStreak(uniqueDays);

  // consistent-month: count Berlin-local calendar months that have ≥25
  // distinct active days.
  const monthBuckets = new Map<string, Set<string>>();
  for (const day of uniqueDays) {
    const month = day.slice(0, 7); // YYYY-MM
    const set = monthBuckets.get(month) ?? new Set<string>();
    set.add(day);
    monthBuckets.set(month, set);
  }
  let consistentMonthCount = 0;
  for (const days of monthBuckets.values()) {
    if (days.size >= 25) consistentMonthCount += 1;
  }

  // weekend-warrior: count of consecutive (Saturday + Sunday) pairs
  // both with at least one entry. We walk the unique day list and
  // count Sat-Sun pairs, then find the longest run of consecutive
  // weekends with both days active. The threshold is currently 4
  // (defined by the achievement); we expose the *count of consecutive
  // weekend pairs in the longest streak* so the UI can also show
  // progress.
  const daySet = new Set(uniqueDays);
  // Build the list of weekend-pair "yes/no" markers ordered by date.
  // Iterate over every Saturday in the date range from the first
  // active day to the last.
  const firstDay = uniqueDays[0];
  const lastDay = uniqueDays[uniqueDays.length - 1];
  let weekendStreakCount = 0;
  let weekendRun = 0;
  // Walk one Saturday at a time. Use a simple `Date` cursor; the
  // Berlin TZ formatter resolves the weekday so DST shifts are safe.
  const cursor = parseDayKey(firstDay);
  const end = parseDayKey(lastDay);
  // Snap cursor to the next Saturday at 12:00 UTC (avoids DST edges).
  cursor.setUTCHours(12, 0, 0, 0);
  while (berlinWeekday(cursor) !== "Sat") {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (cursor > end) break;
  }
  while (cursor <= end) {
    const sat = toBerlinDayKey(cursor);
    const sunDate = new Date(cursor);
    sunDate.setUTCDate(sunDate.getUTCDate() + 1);
    const sun = toBerlinDayKey(sunDate);
    if (daySet.has(sat) && daySet.has(sun)) {
      weekendRun += 1;
      weekendStreakCount = Math.max(weekendStreakCount, weekendRun);
    } else {
      weekendRun = 0;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }

  return { consistentMonthCount, entryDayStreak, weekendStreakCount };
}

function parseDayKey(dayKey: string): Date {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

/**
 * Hidden Easter-egg metrics. Each metric is a *count* (not a streak)
 * so the achievement target = 1 fires the first time the trigger is
 * met. Triggers never reveal themselves to the user — locked cards
 * paint the opaque placeholder.
 */
export function getHiddenMetrics(input: {
  measurements: MeasurementRecord[];
  moodEntries: MoodEntryRecord[];
  intakeEvents: IntakeEventRecord[];
  auditEvents: AuditLogRecord[];
}): {
  nightOwlCount: number;
  earlyBirdCount: number;
  leapDayCount: number;
  doctorPdfCount: number;
  localeFlipCount: number;
} {
  let nightOwl = 0;
  let earlyBird = 0;
  let leapDay = 0;

  const allTimestamps: Date[] = [];
  for (const m of input.measurements) allTimestamps.push(m.measuredAt);
  for (const e of input.moodEntries) allTimestamps.push(e.moodLoggedAt);
  for (const i of input.intakeEvents) {
    if (i.takenAt) allTimestamps.push(i.takenAt);
  }

  for (const ts of allTimestamps) {
    const hour = berlinHour(ts);
    if (hour >= 2 && hour < 4) nightOwl += 1;
    if (hour >= 4 && hour < 6) earlyBird += 1;
    const dayKey = toBerlinDayKey(ts);
    // Feb 29 — only valid in leap years.
    if (dayKey.endsWith("-02-29")) leapDay += 1;
  }

  let doctorPdfCount = 0;
  let localeFlipCount = 0;
  for (const ev of input.auditEvents) {
    if (ev.action === "doctor-report.export") doctorPdfCount += 1;
    if (ev.action === "settings.locale.update") localeFlipCount += 1;
  }

  return {
    nightOwlCount: nightOwl,
    earlyBirdCount: earlyBird,
    leapDayCount: leapDay,
    doctorPdfCount,
    localeFlipCount,
  };
}

/**
 * v1.4.18 — earnability flags. A flag is true iff the user has at
 * least one underlying data point for the metric category. The
 * discovery filter consumes this to decide whether a public locked
 * achievement should render.
 */
export function getEarnabilityFlags(input: {
  hasMedication: boolean;
  moodEntryCount: number;
  measurementCounts: MeasurementCounts;
}): EarnabilityFlags {
  return {
    hasMedication: input.hasMedication,
    hasMood: input.moodEntryCount > 0,
    hasWeight: input.measurementCounts.weightCount > 0,
    hasBp: input.measurementCounts.bpCount > 0,
    hasPulse: input.measurementCounts.pulseCount > 0,
  };
}

export type ExpansionMetrics = {
  moodEntryCount: number;
  moodDayStreak: number;
  moodImprovementHit: number;
  weightMeasurementCount: number;
  bpMeasurementCount: number;
  pulseMeasurementCount: number;
  consistentMonthCount: number;
  entryDayStreak: number;
  weekendStreakCount: number;
  nightOwlCount: number;
  earlyBirdCount: number;
  leapDayCount: number;
  doctorPdfCount: number;
  localeFlipCount: number;
};

export function buildExpansionMetricValues(input: {
  measurements: MeasurementRecord[];
  moodEntries: MoodEntryRecord[];
  intakeEvents: IntakeEventRecord[];
  auditEvents: AuditLogRecord[];
}): ExpansionMetrics {
  const counts = countMeasurementsByType(input.measurements);
  const mood = getMoodMetrics(input.moodEntries);
  const engagement = getEngagementMetrics({
    measurements: input.measurements,
    moodEntries: input.moodEntries,
    intakeEvents: input.intakeEvents,
  });
  const hidden = getHiddenMetrics({
    measurements: input.measurements,
    moodEntries: input.moodEntries,
    intakeEvents: input.intakeEvents,
    auditEvents: input.auditEvents,
  });

  return {
    moodEntryCount: mood.moodEntryCount,
    moodDayStreak: mood.moodDayStreak,
    moodImprovementHit: mood.moodImprovementHit,
    weightMeasurementCount: counts.weightCount,
    bpMeasurementCount: counts.bpCount,
    pulseMeasurementCount: counts.pulseCount,
    consistentMonthCount: engagement.consistentMonthCount,
    entryDayStreak: engagement.entryDayStreak,
    weekendStreakCount: engagement.weekendStreakCount,
    nightOwlCount: hidden.nightOwlCount,
    earlyBirdCount: hidden.earlyBirdCount,
    leapDayCount: hidden.leapDayCount,
    doctorPdfCount: hidden.doctorPdfCount,
    localeFlipCount: hidden.localeFlipCount,
  };
}
