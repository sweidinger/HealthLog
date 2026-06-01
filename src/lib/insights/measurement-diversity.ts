/**
 * v1.8.5 — measurement-diversity detection for the insights category
 * pages.
 *
 * When a user's readings for a metric cluster on a single weekday (only
 * Tuesdays) or a narrow time-of-day band (always right after waking),
 * the trend reads a biased slice of reality. This helper inspects the
 * timestamps of a bounded recent window and, if the spread is too
 * narrow, returns a hint the page surfaces as a gentle nudge to measure
 * on other days / times.
 *
 * Pure + deterministic over ISO timestamp strings so it is trivially
 * unit-tested and cache-friendly: the component computes it from the
 * raw rows it already has, with no blocking work and no extra round-trip
 * beyond the bounded list fetch it shares with the values subpage.
 */

export type DiversityKind = "weekday" | "timeOfDay";

export interface DiversitySignal {
  kind: DiversityKind;
  /** Share (0–1) of readings that fell in the dominant bucket. */
  share: number;
}

/**
 * Minimum number of valid readings before the nudge can fire. Below
 * this the clustering is not yet meaningful — a handful of readings on
 * one day is normal for a brand-new metric.
 */
const MIN_SAMPLES = 8;

/**
 * Fraction of readings that must fall in a single bucket for the bucket
 * to count as a cluster. 0.7 keeps the nudge conservative — it only
 * fires when the spread is genuinely lopsided.
 */
const CLUSTER_THRESHOLD = 0.7;

/**
 * Time-of-day bands (in hours). A reading clusters by time when ≥
 * `CLUSTER_THRESHOLD` of readings fall in the same 6-hour band.
 */
const TIME_BAND_HOURS = 6;

interface LocalParts {
  weekday: number; // 0–6
  hour: number; // 0–23
}

/**
 * Resolve a timestamp's weekday + hour in the given IANA timezone, or
 * the runtime-local zone when none is supplied. Returns null for an
 * unparseable timestamp so the caller can skip it.
 */
function localParts(iso: string, timeZone?: string): LocalParts | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  if (!timeZone) {
    return { weekday: date.getDay(), hour: date.getHours() };
  }
  // Intl resolves the wall-clock weekday + hour in the target zone.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(date);
  const weekdayName = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const weekday = weekdayMap[weekdayName] ?? 0;
  // `hour12: false` can emit "24" for midnight in some engines.
  const hour = Number(hourStr) % 24;
  return { weekday, hour: Number.isFinite(hour) ? hour : 0 };
}

/**
 * Inspect the timestamps and return the dominant clustering signal, or
 * null when the readings are well spread (or below the sample floor).
 * Weekday clustering takes precedence — it is the coarser, more
 * actionable bias ("you only measure on Tuesdays").
 */
export function detectMeasurementDiversity(
  timestamps: ReadonlyArray<string>,
  timeZone?: string,
): DiversitySignal | null {
  const parts: LocalParts[] = [];
  for (const iso of timestamps) {
    const p = localParts(iso, timeZone);
    if (p) parts.push(p);
  }
  if (parts.length < MIN_SAMPLES) return null;

  // Weekday histogram.
  const weekdayCounts = new Array<number>(7).fill(0);
  for (const p of parts) weekdayCounts[p.weekday] += 1;
  const topWeekday = Math.max(...weekdayCounts);
  const weekdayShare = topWeekday / parts.length;
  if (weekdayShare >= CLUSTER_THRESHOLD) {
    return { kind: "weekday", share: weekdayShare };
  }

  // Time-of-day histogram (6-hour bands → 4 buckets).
  const bandCount = Math.ceil(24 / TIME_BAND_HOURS);
  const bandCounts = new Array<number>(bandCount).fill(0);
  for (const p of parts) {
    bandCounts[Math.floor(p.hour / TIME_BAND_HOURS) % bandCount] += 1;
  }
  const topBand = Math.max(...bandCounts);
  const timeShare = topBand / parts.length;
  if (timeShare >= CLUSTER_THRESHOLD) {
    return { kind: "timeOfDay", share: timeShare };
  }

  return null;
}
