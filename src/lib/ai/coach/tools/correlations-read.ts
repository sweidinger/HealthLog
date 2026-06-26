/**
 * v1.21.0 (C3) — Coach correlations reader.
 *
 * Surfaces the deterministic insight engine's cross-metric intelligence to the
 * Coach via the `get_correlations` tool. Two read-only sources, both already
 * computed elsewhere and reused verbatim here (no new statistics):
 *
 *  - The FDR-controlled, day-D→D+1 lagged all-pairs discovery
 *    (`@/lib/insights/correlation-discovery`). We run the SAME full-matrix scan
 *    the `/api/insights/correlations` route + the per-metric card run, so the
 *    Coach never surfaces a pair the insight pages would not — same Pearson,
 *    same exact p-value, same Benjamini-Hochberg control. We return every
 *    surviving pair (not filtered to one metric) as a descriptive driver row.
 *  - The coincident-deviation flag (`computeCoincidentDeviation`): "two or more
 *    of your vitals are outside their usual band today", with the illness-
 *    explained reframe carried through.
 *
 * Grounding posture mirrors the other tools: a structured `{ present: false }`
 * when too little paired data exists for any pattern to survive (or the read
 * fails), never a throw and never an ambiguous empty list. The driver rows are
 * descriptive — direction + lag + n + the engine's own never-causal
 * interpretation string — so the Coach states the observed linkage without
 * inventing a relationship.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import {
  discoverCorrelations,
  DISCOVERY_BEHAVIOURS,
  DISCOVERY_OUTCOMES,
  type DailySeriesPoint,
  type NamedSeries,
} from "@/lib/insights/correlation-discovery";
import {
  computeCoincidentDeviation,
  loadBaselineProfile,
  isDerivedOk,
} from "@/lib/insights/derived";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Trailing window for the discovery scan — mirrors the insight route. */
const WINDOW_DAYS = 180;

/** One discovered driver pair, descriptive — never causal. */
export interface CoachCorrelationDriver {
  behaviour: string;
  outcome: string;
  /** "higher" / "lower" — sign of the next-day association. */
  direction: "higher" | "lower";
  /** Lag in days (always 1 today). */
  lagDays: number;
  /** Paired-day sample count after the lag join. */
  n: number;
  /** Pearson r, rounded for display. */
  r: number;
  /** The engine's conservative, descriptive interpretation. */
  note: string;
}

/** The coincident-deviation summary the Coach can narrate. */
export interface CoachCoincidentFlag {
  /** True when ≥2 vitals are outside their usual band on the latest day. */
  fired: boolean;
  /** The vitals outside their band (possible factors, never a cause). */
  contributing: Array<{ metric: string; direction: "above" | "below" }>;
  /** The day the flag was evaluated (YYYY-MM-DD). */
  day: string;
  /** True when an active illness episode explains the deviations. */
  illnessExplained: boolean;
}

export interface CoachCorrelationsResult {
  present: boolean;
  drivers?: CoachCorrelationDriver[];
  coincident?: CoachCoincidentFlag;
  /** How many behaviour×outcome pairs were tested (honest footer). */
  pairsTested?: number;
  /** Trailing-day window the discovery scanned. */
  windowDays?: number;
  reason?: string;
}

/** Day key (YYYY-MM-DD) for an instant in the user's display timezone. */
function tzDayKey(at: Date, tz: string): string {
  const { year, month, day } = wallClockInTz(at, tz);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Collapse rows to per-day means keyed in the user's tz. */
function toDailyMeans(
  rows: Array<{ value: number; at: Date }>,
  tz: string,
): DailySeriesPoint[] {
  const byDay = new Map<string, { sum: number; count: number }>();
  for (const r of rows) {
    if (!Number.isFinite(r.value)) continue;
    const day = tzDayKey(r.at, tz);
    const acc = byDay.get(day) ?? { sum: 0, count: 0 };
    acc.sum += r.value;
    acc.count += 1;
    byDay.set(day, acc);
  }
  return [...byDay.entries()]
    .map(([day, acc]) => ({ day, value: acc.sum / acc.count }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}

/** Lower-case, space-separated label from a discovery channel key. */
function humanise(key: string): string {
  return key.replace(/_/g, " ").toLowerCase();
}

/**
 * Build the Coach correlations payload for a user. Returns `{ present: false }`
 * when no driver survives AND the coincident flag is not informative, when the
 * user has no correlatable data, or on any read/compute failure (best-effort —
 * a correlation hiccup must never break the chat turn).
 */
export async function readCoachCorrelations(
  userId: string,
): Promise<CoachCorrelationsResult> {
  try {
    const profile = await loadBaselineProfile(prisma, userId);
    const userRow = await prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    const tz = userRow?.timezone ?? "Europe/Berlin";
    const since = new Date(Date.now() - WINDOW_DAYS * MS_PER_DAY);

    // MOOD is mood-entry backed, not a measurement type — strip it from the
    // measurement query and source it separately, exactly like the route.
    const behaviourTypes = DISCOVERY_BEHAVIOURS.filter(
      (k) => k !== "MOOD",
    ) as MeasurementType[];
    const outcomeTypes = DISCOVERY_OUTCOMES.filter(
      (k) => k !== "MOOD",
    ) as MeasurementType[];

    const [measurements, moodEntries, coincidentDerived] = await Promise.all([
      prisma.measurement.findMany({
        where: {
          userId,
          deletedAt: null,
          measuredAt: { gte: since },
          type: { in: [...behaviourTypes, ...outcomeTypes] },
        },
        orderBy: { measuredAt: "asc" },
        take: 20000,
        select: { type: true, value: true, measuredAt: true },
      }),
      prisma.moodEntry.findMany({
        where: { userId, deletedAt: null, moodLoggedAt: { gte: since } },
        orderBy: { moodLoggedAt: "asc" },
        take: 5000,
        select: { score: true, moodLoggedAt: true },
      }),
      // Coincident-deviation is its own derived metric — fail-soft to null so a
      // baseline hiccup never sinks the whole correlations read. D2-8: pass the
      // user's tz so the "today" grouping matches the user's calendar day, not
      // UTC's, before the fired flag is narrated as "out of band TODAY".
      computeCoincidentDeviation(userId, profile, { tz }).catch(() => null),
    ]);

    const byType = new Map<string, Array<{ value: number; at: Date }>>();
    for (const m of measurements) {
      const list = byType.get(m.type) ?? [];
      list.push({ value: m.value, at: m.measuredAt });
      byType.set(m.type, list);
    }
    const moodDaily = toDailyMeans(
      moodEntries.map((e) => ({ value: e.score, at: e.moodLoggedAt })),
      tz,
    );

    const series: NamedSeries[] = [];
    for (const key of DISCOVERY_BEHAVIOURS) {
      const points =
        key === "MOOD" ? moodDaily : toDailyMeans(byType.get(key) ?? [], tz);
      series.push({ key, role: "behaviour", points });
    }
    for (const key of DISCOVERY_OUTCOMES) {
      const points =
        key === "MOOD" ? moodDaily : toDailyMeans(byType.get(key) ?? [], tz);
      series.push({ key, role: "outcome", points });
    }

    const discovery = discoverCorrelations(series);
    const drivers: CoachCorrelationDriver[] = discovery.discovered.map((d) => ({
      behaviour: humanise(d.behaviour),
      outcome: humanise(d.outcome),
      direction: d.r >= 0 ? "higher" : "lower",
      lagDays: d.lagDays,
      n: d.n,
      r: Math.round(d.r * 100) / 100,
      note: d.interpretation,
    }));

    const coincident = buildCoincidentFlag(coincidentDerived);

    // Nothing to say: no surviving driver AND the coincident flag is either
    // insufficient or quiet (not fired). Report a clean miss.
    if (drivers.length === 0 && (!coincident || !coincident.fired)) {
      return { present: false, reason: "no_significant_pattern" };
    }

    return {
      present: true,
      ...(drivers.length > 0 ? { drivers } : {}),
      ...(coincident ? { coincident } : {}),
      pairsTested: discovery.pairsTested,
      windowDays: WINDOW_DAYS,
    };
  } catch {
    return { present: false, reason: "retrieval_failed" };
  }
}

/** Shape the derived coincident-deviation value into the Coach summary. */
function buildCoincidentFlag(
  derived: Awaited<ReturnType<typeof computeCoincidentDeviation>> | null,
): CoachCoincidentFlag | undefined {
  if (!derived || !isDerivedOk(derived)) return undefined;
  const v = derived.value;
  return {
    fired: v.fired,
    contributing: v.contributing.map((c) => ({
      metric: humanise(String(c.type)),
      direction: c.direction === "above" ? "above" : "below",
    })),
    day: v.day,
    illnessExplained: v.illnessExplained,
  };
}
