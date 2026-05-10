/**
 * Snapshot builder for the Coach prompt.
 *
 * Reuses the analytics features pipeline so the Coach narrates the
 * exact same numbers the dashboard tiles render — single source of
 * truth for every "your avg30 BP is …" claim. The output is a compact
 * JSON block the system + user prompt frame as the SNAPSHOT for the
 * model to ground its reply in.
 *
 * v1.4.20.1 — extended with a day-level `timeline` block. The earlier
 * shipping shape carried only aggregated statistics (mean, slope, SD,
 * range, count) per metric, so a Coach turn could not answer questions
 * keyed to a specific day or weekday ("why was BP higher last
 * Monday?"). The timeline now ships the last 14 days as raw daily
 * values with weekday labels and aggregates the older window into
 * weekly buckets so the prompt budget stays tight.
 */
import { prisma } from "@/lib/db";
import { extractFeatures } from "@/lib/insights/features";
import type {
  CoachProvenance,
  CoachScope,
  CoachScopeSource,
  CoachScopeWindow,
} from "./types";

export interface CoachSnapshotResult {
  snapshotJson: string;
  /**
   * Provenance built from snapshot keys actually present. Stays in
   * sync with the SNAPSHOT block so the source-chip row mirrors what
   * the model could see.
   */
  provenance: CoachProvenance;
}

/**
 * Day-level cap for the raw timeline. Days within this window are kept
 * verbatim (one entry per day with weekday). Older days inside the
 * snapshot window are folded into weekly means so a 90-day window
 * lands at ~14 day-rows + ~11 week-rows ≈ 25 rows per metric — well
 * under the 3 000-token Coach turn budget on a 5-metric snapshot.
 */
const DAILY_TIMELINE_DAYS = 14;

/** Default window when the caller doesn't pass a scope. */
const DEFAULT_WINDOW: CoachScopeWindow = "last30days";
const DEFAULT_SOURCES: ReadonlyArray<CoachScopeSource> = [
  "bp",
  "weight",
  "pulse",
  "mood",
  "compliance",
];

const WEEKDAY_KEYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function windowToDays(window: CoachScopeWindow): number {
  switch (window) {
    case "last7days":
      return 7;
    case "last30days":
      return 30;
    case "last90days":
      return 90;
    case "allTime":
      // Cap "allTime" at one year for the timeline. The aggregate
      // section already cites multi-year ranges via the features
      // pipeline; the timeline stays tight to keep token budget sane.
      return 365;
  }
}

/** UTC YYYY-MM-DD key — the same partition the dashboard uses. */
function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 0..6 → "Sun".."Sat" using UTC weekday so display is timezone-stable. */
function utcWeekday(date: Date): string {
  return WEEKDAY_KEYS[date.getUTCDay()];
}

/** ISO week key like 2026-W19 — used for the weekly-bucket section. */
function isoWeekKey(date: Date): string {
  // Copy date and align to Thursday of the same ISO week so the
  // year-week pair matches the standard ISO 8601 calendar.
  const copy = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayNum = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((copy.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${copy.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

interface DailyValueRow {
  date: string;
  weekday: string;
  value: number;
}

interface DailyBpRow {
  date: string;
  weekday: string;
  sys: number;
  dia: number;
}

interface WeeklyBucket {
  weekISO: string;
  mean: number;
  count: number;
}

/**
 * Group raw measurements (one per row, possibly several per day) into
 * one entry per UTC day. Multiple readings on the same day are folded
 * into the daily mean — clinically the morning reading is what the
 * Coach is usually asked about, but the snapshot stays pre-clinical
 * and takes the straight mean to avoid presenting a fabricated number.
 */
function dailyMeans<T extends { measuredAt: Date; value: number }>(
  rows: T[],
): Map<string, { date: Date; values: number[] }> {
  const grouped = new Map<string, { date: Date; values: number[] }>();
  for (const r of rows) {
    const key = utcDayKey(r.measuredAt);
    const existing = grouped.get(key);
    if (existing) {
      existing.values.push(r.value);
    } else {
      grouped.set(key, { date: r.measuredAt, values: [r.value] });
    }
  }
  return grouped;
}

function bucketWeekly(
  rows: Array<{ measuredAt: Date; value: number }>,
): WeeklyBucket[] {
  const grouped = new Map<string, number[]>();
  for (const r of rows) {
    const key = isoWeekKey(r.measuredAt);
    const list = grouped.get(key);
    if (list) {
      list.push(r.value);
    } else {
      grouped.set(key, [r.value]);
    }
  }
  return Array.from(grouped.entries())
    .map(([weekISO, values]) => ({
      weekISO,
      mean:
        Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) /
        10,
      count: values.length,
    }))
    .sort((a, b) => a.weekISO.localeCompare(b.weekISO));
}

function buildDailyValueRows(
  rows: Array<{ measuredAt: Date; value: number }>,
  recentCutoff: Date,
): DailyValueRow[] {
  const recent = rows.filter((r) => r.measuredAt >= recentCutoff);
  const grouped = dailyMeans(recent);
  return Array.from(grouped.entries())
    .map(([date, info]) => {
      const mean = info.values.reduce((s, v) => s + v, 0) / info.values.length;
      return {
        date,
        weekday: utcWeekday(info.date),
        value: Math.round(mean * 10) / 10,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Pair systolic + diastolic into one row per day. Days with only one
 * side measured are dropped — the Coach is asked about "BP" as a pair,
 * and a half-measured day would invite a fabricated complement.
 */
function buildDailyBpRows(
  sysRows: Array<{ measuredAt: Date; value: number }>,
  diaRows: Array<{ measuredAt: Date; value: number }>,
  recentCutoff: Date,
): DailyBpRow[] {
  const sysRecent = sysRows.filter((r) => r.measuredAt >= recentCutoff);
  const diaRecent = diaRows.filter((r) => r.measuredAt >= recentCutoff);
  const sysByDay = dailyMeans(sysRecent);
  const diaByDay = dailyMeans(diaRecent);
  const out: DailyBpRow[] = [];
  for (const [day, info] of sysByDay) {
    const dia = diaByDay.get(day);
    if (!dia) continue;
    const sysMean = info.values.reduce((s, v) => s + v, 0) / info.values.length;
    const diaMean = dia.values.reduce((s, v) => s + v, 0) / dia.values.length;
    out.push({
      date: day,
      weekday: utcWeekday(info.date),
      sys: Math.round(sysMean),
      dia: Math.round(diaMean),
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Resolve the working scope. Missing fields fall through to defaults
 * so older native clients (no scope picker) keep getting the full
 * 30-day, all-source snapshot they had before v1.4.20.1.
 */
function resolveScope(scope?: CoachScope): {
  sources: ReadonlySet<CoachScopeSource>;
  window: CoachScopeWindow;
} {
  const sources =
    scope?.sources && scope.sources.length > 0
      ? new Set(scope.sources)
      : new Set(DEFAULT_SOURCES);
  return {
    sources,
    window: scope?.window ?? DEFAULT_WINDOW,
  };
}

/**
 * Build the Coach prompt snapshot for `userId`. Always uses
 * `includeRaw=false` because the Coach replies are conversational and
 * the user is asking the model — they should never depend on raw
 * measurement timestamps that the privacy mode controls.
 *
 * The snapshot now carries two sections per active metric:
 *   - aggregate: the v1.4.20 shape (mean, slope, SD, range, count)
 *   - timeline.recent: last `DAILY_TIMELINE_DAYS` days as raw daily
 *     values with weekday labels so the Coach can answer
 *     day/weekday-specific questions
 *   - timeline.weekly: ISO-week buckets covering the rest of the
 *     window so the Coach can still cite older weeks without ballooning
 *     the prompt
 */
export async function buildCoachSnapshot(
  userId: string,
  scope?: CoachScope,
): Promise<CoachSnapshotResult> {
  const { sources, window } = resolveScope(scope);
  const windowDays = windowToDays(window);
  const features = await extractFeatures(userId, false, {
    sinceDays: windowDays,
  });

  // Trim down to the metrics the Coach narrates. extractFeatures
  // returns more (sleep, steps, etc.) — the Coach surface keeps the
  // snapshot tight so each turn fits inside the provider's context
  // budget for free-tier accounts.
  const snapshot: Record<string, unknown> = {};
  const windows = new Set<CoachProvenance["windows"][number]>();
  const metrics = new Set<CoachProvenance["metrics"][number]>();
  const counts: NonNullable<CoachProvenance["counts"]> = {};

  // Pull raw measurement rows once for the configured window so day
  // and week buckets share a single I/O hop. Mood + compliance live in
  // separate tables and are loaded conditionally below.
  const now = new Date();
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const recentCutoff = new Date(
    now.getTime() - DAILY_TIMELINE_DAYS * 24 * 60 * 60 * 1000,
  );

  const wantsBp = sources.has("bp");
  const wantsWeight = sources.has("weight");
  const wantsPulse = sources.has("pulse");
  const wantsMood = sources.has("mood");
  const wantsCompliance = sources.has("compliance");
  // v1.4.23 — additive Apple Health sources. The default scope leaves
  // them off, so non-iOS accounts never pay the SQL `WHERE type IN`
  // overhead. iOS callers explicitly include them in `scope.sources`.
  const wantsHrv = sources.has("hrv");
  const wantsSleep = sources.has("sleep");
  const wantsRestingHr = sources.has("resting_hr");
  const wantsSteps = sources.has("steps");
  const wantsActiveEnergy = sources.has("active_energy");
  const wantsFlights = sources.has("flights");
  const wantsDistance = sources.has("distance");
  const wantsVo2Max = sources.has("vo2_max");
  const wantsBodyTemp = sources.has("body_temp");

  // Single fetch for all measurement types — Prisma's filter pushes
  // the type list into one SQL `WHERE type IN (…)` so we don't pay
  // per-metric round-trips.
  const wantedTypes: string[] = [];
  if (wantsBp) wantedTypes.push("BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA");
  if (wantsWeight) wantedTypes.push("WEIGHT");
  if (wantsPulse) wantedTypes.push("PULSE");
  if (wantsHrv) wantedTypes.push("HEART_RATE_VARIABILITY");
  if (wantsSleep) wantedTypes.push("SLEEP_DURATION");
  if (wantsRestingHr) wantedTypes.push("RESTING_HEART_RATE");
  if (wantsSteps) wantedTypes.push("ACTIVITY_STEPS");
  if (wantsActiveEnergy) wantedTypes.push("ACTIVE_ENERGY_BURNED");
  if (wantsFlights) wantedTypes.push("FLIGHTS_CLIMBED");
  if (wantsDistance) wantedTypes.push("WALKING_RUNNING_DISTANCE");
  if (wantsVo2Max) wantedTypes.push("VO2_MAX");
  if (wantsBodyTemp) wantedTypes.push("BODY_TEMPERATURE");

  const measurementRows =
    wantedTypes.length > 0
      ? await prisma.measurement.findMany({
          where: {
            userId,
            type: { in: wantedTypes as never[] },
            measuredAt: { gte: cutoff },
          },
          orderBy: { measuredAt: "asc" },
          select: { type: true, value: true, measuredAt: true },
        })
      : [];

  const byType = (t: string) =>
    measurementRows
      .filter((r) => r.type === t)
      .map((r) => ({
        measuredAt: r.measuredAt,
        value: r.value,
      }));

  if (wantsBp && features.bloodPressure) {
    const sysRows = byType("BLOOD_PRESSURE_SYS");
    const diaRows = byType("BLOOD_PRESSURE_DIA");
    const recentDaily = buildDailyBpRows(sysRows, diaRows, recentCutoff);
    const olderSys = sysRows.filter((r) => r.measuredAt < recentCutoff);
    const olderDia = diaRows.filter((r) => r.measuredAt < recentCutoff);
    snapshot.bloodPressure = {
      aggregate: features.bloodPressure,
      timeline: {
        recent: recentDaily,
        weeklySys: bucketWeekly(olderSys),
        weeklyDia: bucketWeekly(olderDia),
      },
    };
    metrics.add("bp");
    windows.add("last30days");
    windows.add("last90days");
    counts.bp = features.bloodPressure.coverage?.count ?? undefined;
  }
  if (wantsWeight && features.weight) {
    const rows = byType("WEIGHT");
    snapshot.weight = {
      aggregate: features.weight,
      timeline: {
        recent: buildDailyValueRows(rows, recentCutoff),
        weekly: bucketWeekly(rows.filter((r) => r.measuredAt < recentCutoff)),
      },
    };
    metrics.add("weight");
    windows.add("last7days");
    windows.add("last30days");
    counts.weight = features.weight.coverage?.count ?? undefined;
  }
  if (wantsPulse && features.pulse) {
    const rows = byType("PULSE");
    snapshot.pulse = {
      aggregate: features.pulse,
      timeline: {
        recent: buildDailyValueRows(rows, recentCutoff),
        weekly: bucketWeekly(rows.filter((r) => r.measuredAt < recentCutoff)),
      },
    };
    metrics.add("pulse");
    windows.add("last7days");
    windows.add("last30days");
    windows.add("last90days");
    counts.pulse = features.pulse.coverage?.count ?? undefined;
  }
  if (wantsMood && features.mood) {
    // Mood entries live on a separate model. Pull only the recent
    // window for the day-level rows + bucket the rest.
    const moodRows = await prisma.moodEntry.findMany({
      where: { userId, moodLoggedAt: { gte: cutoff } },
      orderBy: { moodLoggedAt: "asc" },
      select: { moodLoggedAt: true, score: true },
    });
    const normalised = moodRows.map((m) => ({
      measuredAt: m.moodLoggedAt,
      value: m.score,
    }));
    snapshot.mood = {
      aggregate: features.mood,
      timeline: {
        recent: buildDailyValueRows(normalised, recentCutoff),
        weekly: bucketWeekly(
          normalised.filter((r) => r.measuredAt < recentCutoff),
        ),
      },
    };
    metrics.add("mood");
    windows.add("last7days");
    windows.add("last30days");
    counts.mood = features.mood.coverage?.count ?? undefined;
  }

  if (wantsCompliance) {
    // Medication compliance lives outside the structured features
    // today — the legacy Coach surface labelled it as "general"
    // provenance only. v1.4.20.1 ships a per-day adherence row built
    // from the intake-event log so the Coach can answer "did I miss
    // my dose on Tuesday?" without inventing the schedule.
    const intakeRows = await prisma.medicationIntakeEvent.findMany({
      where: { userId, scheduledFor: { gte: cutoff } },
      orderBy: { scheduledFor: "asc" },
      select: { scheduledFor: true, takenAt: true, skipped: true },
    });
    if (intakeRows.length > 0) {
      // Per-day adherence rate within the recent window. Older days
      // collapse into a single weekly bucket.
      const recent = intakeRows.filter((r) => r.scheduledFor >= recentCutoff);
      const olderRows = intakeRows.filter((r) => r.scheduledFor < recentCutoff);
      const recentByDay = new Map<
        string,
        { date: Date; total: number; taken: number }
      >();
      for (const r of recent) {
        const key = utcDayKey(r.scheduledFor);
        const e = recentByDay.get(key) ?? {
          date: r.scheduledFor,
          total: 0,
          taken: 0,
        };
        e.total += 1;
        if (r.takenAt && !r.skipped) e.taken += 1;
        recentByDay.set(key, e);
      }
      const recentRows = Array.from(recentByDay.entries())
        .map(([date, info]) => ({
          date,
          weekday: utcWeekday(info.date),
          rate: Math.round((info.taken / info.total) * 100) / 100,
          taken: info.taken,
          total: info.total,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
      const olderByWeek = new Map<string, { taken: number; total: number }>();
      for (const r of olderRows) {
        const key = isoWeekKey(r.scheduledFor);
        const e = olderByWeek.get(key) ?? { taken: 0, total: 0 };
        e.total += 1;
        if (r.takenAt && !r.skipped) e.taken += 1;
        olderByWeek.set(key, e);
      }
      const weeklyRows = Array.from(olderByWeek.entries())
        .map(([weekISO, v]) => ({
          weekISO,
          rate: v.total > 0 ? Math.round((v.taken / v.total) * 100) / 100 : 0,
          taken: v.taken,
          total: v.total,
        }))
        .sort((a, b) => a.weekISO.localeCompare(b.weekISO));
      snapshot.compliance = {
        timeline: { recent: recentRows, weekly: weeklyRows },
      };
      metrics.add("compliance");
      counts.compliance = intakeRows.length;
    }
  }

  // ── v1.4.23 Apple Health additive blocks ─────────────────────────
  //
  // Each new HealthKit-derived metric ships as a timeline-only block
  // (recent day rows + older weekly buckets). The aggregate features
  // pipeline doesn't carry them yet — that's a v1.5 follow-up — but
  // the timeline alone is enough for the Coach to ground "your HRV
  // last Tuesday was X" replies in real numbers without inventing a
  // baseline. The block is omitted entirely when the user has no rows
  // for that metric, so accounts without iOS data never see a void
  // section in the prompt.
  type AppleHealthMetric = Exclude<
    CoachProvenance["metrics"][number],
    "general" | "bp" | "weight" | "pulse" | "mood" | "compliance"
  >;
  type AppleHealthBlock = {
    metric: AppleHealthMetric;
    snapshotKey: string;
    type: string;
    enabled: boolean;
  };
  const appleHealthBlocks: AppleHealthBlock[] = [
    { metric: "hrv", snapshotKey: "heartRateVariability", type: "HEART_RATE_VARIABILITY", enabled: wantsHrv },
    { metric: "sleep", snapshotKey: "sleep", type: "SLEEP_DURATION", enabled: wantsSleep },
    { metric: "resting_hr", snapshotKey: "restingHeartRate", type: "RESTING_HEART_RATE", enabled: wantsRestingHr },
    { metric: "steps", snapshotKey: "steps", type: "ACTIVITY_STEPS", enabled: wantsSteps },
    { metric: "active_energy", snapshotKey: "activeEnergy", type: "ACTIVE_ENERGY_BURNED", enabled: wantsActiveEnergy },
    { metric: "flights", snapshotKey: "flightsClimbed", type: "FLIGHTS_CLIMBED", enabled: wantsFlights },
    { metric: "distance", snapshotKey: "walkingRunningDistance", type: "WALKING_RUNNING_DISTANCE", enabled: wantsDistance },
    { metric: "vo2_max", snapshotKey: "vo2Max", type: "VO2_MAX", enabled: wantsVo2Max },
    { metric: "body_temp", snapshotKey: "bodyTemperature", type: "BODY_TEMPERATURE", enabled: wantsBodyTemp },
  ];
  for (const block of appleHealthBlocks) {
    if (!block.enabled) continue;
    const rows = byType(block.type);
    if (rows.length === 0) continue;
    snapshot[block.snapshotKey] = {
      timeline: {
        recent: buildDailyValueRows(rows, recentCutoff),
        weekly: bucketWeekly(rows.filter((r) => r.measuredAt < recentCutoff)),
      },
    };
    metrics.add(block.metric);
    counts[block.metric] = rows.length;
  }

  if (Object.keys(snapshot).length === 0) {
    metrics.add("general");
  }

  // Pin the scope onto the snapshot itself so the model knows which
  // windows + sources are in-bounds for the reply. The system prompt
  // tells the model to read from this block for day-level questions.
  snapshot.scope = {
    window,
    sources: Array.from(sources),
    timelineRecentDays: DAILY_TIMELINE_DAYS,
  };

  return {
    snapshotJson: JSON.stringify(snapshot, null, 2),
    provenance: {
      windows: Array.from(windows),
      metrics: Array.from(metrics),
      counts: Object.keys(counts).length > 0 ? counts : undefined,
    },
  };
}
