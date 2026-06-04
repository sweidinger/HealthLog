/**
 * v1.11.4 — per-night sleep aggregation (iOS #1, HIGH).
 *
 * `SLEEP_DURATION` is stored in MINUTES, one row per sleep STAGE per
 * night (IN_BED / AWAKE / ASLEEP / REM / CORE / DEEP) since v1.4.23. The
 * value is NOT cumulative — a single stage row carries only that stage's
 * minutes. Every "last night's sleep" surface therefore has to SUM the
 * stage rows belonging to one night before it shows a headline number;
 * reading the single most-recent row gives one stage, not the night.
 *
 * This helper is the one shared place that turns the raw per-stage rows
 * into per-night totals. The headline "time asleep" is light(CORE) +
 * deep + REM (+ legacy bare `ASLEEP`); IN_BED and AWAKE are excluded
 * from the asleep total, matching the AASM convention already encoded in
 * `sleep-score.ts`'s `ASLEEP_STAGES`. Bare rows with no `sleepStage`
 * (legacy / manual) count as that night's asleep total.
 *
 * Night grouping
 * --------------
 * A "night" is one SLEEP SESSION, not a calendar day. `measuredAt` is the
 * stage segment's END instant (`apple-health-mapping.ts` sets
 * `takenAt = endDate`), and a device writes one row per stage segment, so a
 * normal overnight sleep (asleep before local midnight) spreads its segments
 * across BOTH sides of midnight. Keying each segment by its own calendar day
 * would split one physical night into two partial nights and undercount the
 * "last night" headline.
 *
 * Instead we cluster the segments into sessions by time gap: sort by
 * `measuredAt`, and start a new session whenever the gap from the previous
 * segment exceeds `SESSION_GAP_MS` (3 h). Stage segments inside one sleep
 * session are contiguous (minutes to ~2 h apart), so a > 3 h gap reliably
 * marks the boundary between a daytime nap and the overnight session, or
 * between two genuine sessions in one day — they stay separable. The gap is
 * measured on the absolute UTC instant, so it is immune to DST shifts.
 *
 * Each session is keyed by the LOCAL WAKE DAY — `userDayKey` of the session's
 * LAST segment (its end instant) in the user's timezone. This matches the
 * Apple Health convention (a sleep session is attributed to the date you wake
 * up) and keeps the keying tz/DST-correct because it runs on the real instant.
 *
 * Source de-dup
 * -------------
 * A user paired to more than one sleep source (e.g. WHOOP + Apple Health)
 * gets per-stage rows for the SAME night from each source. Summing them all
 * would ~double the night total. Before summing a session we collapse it to
 * ONE source using the user's `sleep` source-priority ladder
 * (`DEFAULT_SOURCE_PRIORITY.sleep` = WHOOP > APPLE_HEALTH > WITHINGS): pick the
 * highest-ranked source present in the session, falling back to the source
 * with the most asleep minutes (then source name) when none of the session's
 * sources sits on the ladder. Only that source's segments are summed — sources
 * are never blended within a night. This mirrors the per-(type, day) collapse
 * the rest of the v1.11.x numeric surfaces apply.
 *
 * Unit
 * ----
 * Totals are returned in MINUTES — the canonical `SLEEP_DURATION` unit
 * (`getUnitForType` → "minutes") — so the existing web consumers that
 * already treat the summary as minutes (e.g. the insights overview's
 * `formatHoursMinutes`) keep working unchanged; they now average per-
 * night totals instead of per-stage rows, which is strictly more
 * correct. Callers that want hours convert at the edge (`/ 60`).
 */
import type { MeasurementSource, SleepStage } from "@/generated/prisma/client";
import { userDayKey } from "@/lib/tz/resolver";
import { summarize, type DataSummary } from "@/lib/analytics/trends";
import {
  getSourceLadder,
  parseSourcePriority,
} from "@/lib/validations/source-priority";

/** Stages that count toward "time asleep" (excludes IN_BED + AWAKE). */
const ASLEEP_STAGES: ReadonlySet<SleepStage> = new Set<SleepStage>([
  "ASLEEP",
  "REM",
  "CORE",
  "DEEP",
]);

/**
 * Gap (ms) between consecutive stage segments that starts a new sleep
 * session. Stage segments within one night are contiguous (minutes to a
 * couple of hours apart); a > 3 h gap separates a nap from the overnight
 * block, or two genuine sessions in one day.
 */
const SESSION_GAP_MS = 3 * 60 * 60 * 1000;

export interface SleepStageRow {
  value: number;
  measuredAt: Date;
  sleepStage: SleepStage | null;
  /**
   * Ingest source of the stage row. Used to collapse a multi-source night
   * (e.g. WHOOP + Apple Health) to one canonical source before summing.
   * Optional so legacy callers and fixtures that don't carry a source still
   * type-check (a missing source is treated as a single anonymous source —
   * the de-dup is a no-op for single-source nights).
   */
  source?: MeasurementSource | null;
}

/** One reconstructed night: the asleep total + the per-stage breakdown. */
export interface SleepNight {
  /** Wake-day key (YYYY-MM-DD) in the user's timezone. */
  night: string;
  /** Latest stage instant in the night — the night's representative timestamp. */
  measuredAt: Date;
  /** Time asleep in minutes = CORE + DEEP + REM (+ legacy bare ASLEEP). */
  asleepMinutes: number;
  /** In-bed minutes when an IN_BED row exists, else null. */
  inBedMinutes: number | null;
  /** Awake-in-bed minutes when an AWAKE row exists, else null. */
  awakeMinutes: number | null;
  /** Per-stage minutes for the night (only stages the device reported). */
  stages: Partial<Record<SleepStage, number>>;
}

/** Sentinel for rows that carry no source — collapses to one bucket. */
const NO_SOURCE = "__none__";

/**
 * Pick the one canonical source for a session. The user's `sleep`
 * source-priority ladder wins (lowest ladder index = highest priority).
 * Sources absent from the ladder fall back to "most asleep minutes", then
 * a stable source-name tiebreak. Single-source (or source-less) sessions
 * resolve to that one bucket with no work.
 */
function pickSessionSource(
  rows: SleepStageRow[],
  sleepLadder: readonly MeasurementSource[],
): string {
  const asleepBySource = new Map<string, number>();
  for (const r of rows) {
    const src = r.source ?? NO_SOURCE;
    const stage = r.sleepStage;
    const counts = stage == null || ASLEEP_STAGES.has(stage);
    if (!counts) continue;
    const minutes = Number.isFinite(r.value) ? r.value : 0;
    asleepBySource.set(src, (asleepBySource.get(src) ?? 0) + minutes);
  }
  // No asleep minutes anywhere (IN_BED / AWAKE only) — fall back to the set
  // of all present sources so the session still resolves to a single bucket.
  const sources =
    asleepBySource.size > 0
      ? [...asleepBySource.keys()]
      : [...new Set(rows.map((r) => r.source ?? NO_SOURCE))];
  if (sources.length <= 1) return sources[0] ?? NO_SOURCE;

  const rankOf = (src: string): number => {
    const i = sleepLadder.indexOf(src as MeasurementSource);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return sources.sort((a, b) => {
    const ra = rankOf(a);
    const rb = rankOf(b);
    if (ra !== rb) return ra - rb;
    // Neither (or both) on the ladder — most asleep minutes wins, then name.
    const ma = asleepBySource.get(a) ?? 0;
    const mb = asleepBySource.get(b) ?? 0;
    if (ma !== mb) return mb - ma;
    return a < b ? -1 : 1;
  })[0];
}

/**
 * Group raw per-stage rows into per-night totals. Stages are clustered into
 * sleep SESSIONS by time gap (a > `SESSION_GAP_MS` gap starts a new session),
 * each session keyed by the LOCAL WAKE DAY of its last segment, then collapsed
 * to ONE source via the user's `sleep` priority ladder before summing.
 *
 * Pure — the caller does the bounded DB read. `priorityJson` is the user's
 * persisted `sourcePriorityJson` (or null for the defaults). Nights are
 * returned sorted ascending by key so the last element is the most recent
 * night.
 */
export function reconstructSleepNights(
  rows: SleepStageRow[],
  tz: string,
  priorityJson: unknown = null,
): SleepNight[] {
  if (rows.length === 0) return [];
  const sleepLadder = getSourceLadder(parseSourcePriority(priorityJson), "sleep");

  // Cluster into sessions by the gap between a segment's START and the latest
  // END seen so far in the current session. `measuredAt` is the segment END;
  // the segment START is `end − value minutes`. A new session begins only when
  // the next segment STARTS more than SESSION_GAP_MS after the running end —
  // so a single long stage block (a 4 h CORE) does NOT split a night, and two
  // sources' interleaved/overlapping rows for the same night stay together
  // (their gap is ≤ 0). Gaps are absolute-time, so the clustering is DST-immune.
  // Sort by START so contiguous segments compare end-to-start in order.
  const startOf = (r: SleepStageRow): number =>
    r.measuredAt.getTime() -
    (Number.isFinite(r.value) ? r.value : 0) * 60_000;
  const sorted = [...rows].sort((a, b) => startOf(a) - startOf(b));
  const sessions: SleepStageRow[][] = [];
  let current: SleepStageRow[] = [];
  let sessionEnd = Number.NEGATIVE_INFINITY;
  for (const r of sorted) {
    const start = startOf(r);
    const end = r.measuredAt.getTime();
    if (current.length > 0 && start - sessionEnd > SESSION_GAP_MS) {
      sessions.push(current);
      current = [];
      sessionEnd = Number.NEGATIVE_INFINITY;
    }
    current.push(r);
    if (end > sessionEnd) sessionEnd = end;
  }
  if (current.length > 0) sessions.push(current);

  // Two sessions can land on the same wake day (e.g. a genuine second sleep);
  // merge their rows under one key after the source-collapse so the night key
  // stays unique. Collapse each session to its canonical source first.
  const byNight = new Map<string, SleepStageRow[]>();
  for (const session of sessions) {
    const canonical = pickSessionSource(session, sleepLadder);
    const kept = session.filter((r) => (r.source ?? NO_SOURCE) === canonical);
    const pool = kept.length > 0 ? kept : session;
    // The wake day is the LATEST segment END in the session (Apple Health
    // attributes a session to the morning you wake up).
    const wakeInstant = pool.reduce(
      (max, r) => (r.measuredAt.getTime() > max.getTime() ? r.measuredAt : max),
      pool[0].measuredAt,
    );
    const key = userDayKey(wakeInstant, tz);
    const list = byNight.get(key) ?? [];
    list.push(...kept);
    byNight.set(key, list);
  }

  const nights: SleepNight[] = [];
  for (const [night, nightRows] of byNight) {
    let asleep = 0;
    let inBed = 0;
    let awake = 0;
    let sawInBed = false;
    let sawAwake = false;
    let latest = nightRows[0].measuredAt;
    const stages: Partial<Record<SleepStage, number>> = {};
    for (const r of nightRows) {
      const minutes = Number.isFinite(r.value) ? r.value : 0;
      if (r.measuredAt.getTime() > latest.getTime()) latest = r.measuredAt;
      const stage = r.sleepStage;
      if (stage) {
        stages[stage] = (stages[stage] ?? 0) + minutes;
      }
      if (stage === "IN_BED") {
        inBed += minutes;
        sawInBed = true;
      } else if (stage === "AWAKE") {
        awake += minutes;
        sawAwake = true;
      } else if (stage && ASLEEP_STAGES.has(stage)) {
        asleep += minutes;
      } else if (stage == null) {
        // Bare SLEEP_DURATION row (no stage) — the night's total asleep.
        asleep += minutes;
      }
    }
    nights.push({
      night,
      measuredAt: latest,
      asleepMinutes: asleep,
      inBedMinutes: sawInBed ? inBed : null,
      awakeMinutes: sawAwake ? awake : null,
      stages,
    });
  }
  return nights.sort((a, b) => (a.night < b.night ? -1 : 1));
}

export interface SleepNightSummary {
  /**
   * A `DataSummary` whose every value is a per-night TIME-ASLEEP total
   * (minutes). Drop-in replacement for the per-stage `summaries.
   * SLEEP_DURATION` the slim slice produced. Null when no night has any
   * asleep minutes in the supplied rows.
   */
  summary: DataSummary;
  /** The most recent night (for the dashboard/series headline), or null. */
  latestNight: SleepNight | null;
}

/**
 * Reconstruct nights from raw rows and summarise the per-night asleep
 * totals. Nights with zero asleep minutes are dropped (an IN_BED-only or
 * AWAKE-only fragment is not a scorable night). The returned `summary`
 * uses one DataPoint per night so `summarize()`'s windowed avg7 / avg30
 * become "average nightly sleep over the trailing N days".
 */
export function summarizeSleepNights(
  rows: SleepStageRow[],
  tz: string,
  priorityJson: unknown = null,
): SleepNightSummary {
  const nights = reconstructSleepNights(rows, tz, priorityJson).filter(
    (n) => n.asleepMinutes > 0,
  );
  const dataPoints = nights.map((n) => ({
    date: n.measuredAt,
    value: n.asleepMinutes,
  }));
  return {
    summary: summarize(dataPoints),
    latestNight: nights.length > 0 ? nights[nights.length - 1] : null,
  };
}
