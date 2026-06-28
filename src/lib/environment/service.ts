/**
 * v1.25 (W-ENV) — environmental-context resolution + fetch/upsert service.
 *
 * Owns the location-precedence logic and the per-day upsert into
 * `EnvironmentContext`. Both the nightly job and the on-demand backfill route
 * call {@link fetchAndStoreEnvironment} so the precedence, the day-keying, and
 * the upsert live in exactly one place.
 *
 * Location precedence per day (first hit wins):
 *   1. a manual TRAVEL override whose [startDate, endDate] covers the day;
 *   2. the user's HOME location.
 * No home + no covering override ⇒ the day is skipped (the module degrades
 * silently, matching the rollup "coverage miss → absent" posture).
 *
 * Coarse location only — the resolver never sees finer than the rounded city
 * coordinates stored on the user / override.
 */
import { prisma } from "@/lib/db";
import {
  fetchDailyEnvironment,
  type DailyEnvironmentObservation,
} from "@/lib/environment/open-meteo";
import type { EnvironmentLocationSource } from "@/generated/prisma/client";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Default lookback window (days) for the nightly fetch — absorbs the archive
 * settling lag and any days missed across worker reboots. */
export const ENVIRONMENT_LOOKBACK_DAYS = 7;
/** Hard cap on a single backfill span so one request can never fan out forever. */
export const ENVIRONMENT_MAX_BACKFILL_DAYS = 730;

/** A coarse resolved location for a given day. */
interface ResolvedLocation {
  lat: number;
  lon: number;
  label: string;
  source: EnvironmentLocationSource;
}

interface HomeLocation {
  lat: number;
  lon: number;
  label: string;
  timezone: string;
}

interface TravelOverride {
  startDate: string;
  endDate: string;
  lat: number;
  lon: number;
  label: string;
}

/** UTC YYYY-MM-DD for `date` (used to bound the default lookback window). */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Inclusive list of YYYY-MM-DD keys from `start` to `end` (date arithmetic). */
export function enumerateDays(start: string, end: string): string[] {
  const out: string[] = [];
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  let cur = Date.UTC(sy, sm - 1, sd);
  const last = Date.UTC(ey, em - 1, ed);
  while (cur <= last) {
    out.push(new Date(cur).toISOString().slice(0, 10));
    cur += MS_PER_DAY;
  }
  return out;
}

/**
 * Resolve the location for one day: a covering travel override wins, else home,
 * else null. Pure — exported for unit tests.
 */
export function resolveLocationForDay(
  day: string,
  home: HomeLocation | null,
  travels: readonly TravelOverride[],
): ResolvedLocation | null {
  for (const t of travels) {
    if (day >= t.startDate && day <= t.endDate) {
      return { lat: t.lat, lon: t.lon, label: t.label, source: "TRAVEL" };
    }
  }
  if (home) {
    return { lat: home.lat, lon: home.lon, label: home.label, source: "HOME" };
  }
  return null;
}

/** A location-keyed group of days (one upstream fetch per group). */
function groupKey(loc: ResolvedLocation): string {
  return `${loc.lat},${loc.lon},${loc.source},${loc.label}`;
}

export interface FetchAndStoreResult {
  /** Days that resolved to a location and were upserted. */
  stored: number;
  /** Days skipped because no location resolved (no home, no override). */
  skipped: number;
  /** Distinct upstream fetches made. */
  fetches: number;
}

/**
 * Resolve + fetch + upsert the environment rows for a user across a date range.
 * Groups days by resolved location so each location is fetched once over its
 * contiguous span. A day whose observation is absent from the feed is left
 * un-stored (no fabricated row). Idempotent — re-running upserts the same rows.
 */
export async function fetchAndStoreEnvironment(args: {
  userId: string;
  startDate: string;
  endDate: string;
}): Promise<FetchAndStoreResult> {
  const { userId, startDate, endDate } = args;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      homeLat: true,
      homeLon: true,
      homeLabel: true,
      homeTimezone: true,
      timezone: true,
    },
  });
  if (!user) return { stored: 0, skipped: 0, fetches: 0 };

  const home: HomeLocation | null =
    user.homeLat != null && user.homeLon != null
      ? {
          lat: user.homeLat,
          lon: user.homeLon,
          label: user.homeLabel ?? "Home",
          timezone: user.homeTimezone ?? user.timezone,
        }
      : null;

  const travelRows = await prisma.environmentTravelLocation.findMany({
    where: { userId },
    select: {
      startDate: true,
      endDate: true,
      lat: true,
      lon: true,
      label: true,
    },
  });

  // The timezone used to enumerate AND fetch days — one tz keeps the stored
  // `date` consistent with the user's day-keys elsewhere.
  const timezone = home?.timezone ?? user.timezone;

  const days = enumerateDays(startDate, endDate);
  const resolvedByDay = new Map<string, ResolvedLocation>();
  const groups = new Map<string, { loc: ResolvedLocation; days: string[] }>();
  let skipped = 0;
  for (const day of days) {
    const loc = resolveLocationForDay(day, home, travelRows);
    if (!loc) {
      skipped += 1;
      continue;
    }
    resolvedByDay.set(day, loc);
    const gk = groupKey(loc);
    const group = groups.get(gk) ?? { loc, days: [] };
    group.days.push(day);
    groups.set(gk, group);
  }

  let stored = 0;
  let fetches = 0;
  for (const { loc, days: groupDays } of groups.values()) {
    const min = groupDays[0];
    const max = groupDays[groupDays.length - 1];
    let observations: DailyEnvironmentObservation[];
    try {
      observations = await fetchDailyEnvironment({
        lat: loc.lat,
        lon: loc.lon,
        timezone,
        startDate: min,
        endDate: max,
      });
    } catch {
      // A failed fetch for one location leaves its days un-stored; the nightly
      // lookback re-attempts them. Other locations still get their rows.
      continue;
    }
    fetches += 1;

    const obsByDate = new Map(observations.map((o) => [o.date, o]));
    const wanted = new Set(groupDays);
    for (const obs of observations) {
      if (!wanted.has(obs.date)) continue;
      await upsertObservation(userId, loc, obs);
      stored += 1;
    }
    // Days the feed did not return (e.g. beyond the settling lag) stay absent.
    void obsByDate;
  }

  return { stored, skipped, fetches };
}

async function upsertObservation(
  userId: string,
  loc: ResolvedLocation,
  obs: DailyEnvironmentObservation,
): Promise<void> {
  const data = {
    lat: loc.lat,
    lon: loc.lon,
    locationLabel: loc.label,
    source: loc.source,
    tempMin: obs.tempMin,
    tempMax: obs.tempMax,
    tempMean: obs.tempMean,
    apparentMean: obs.apparentMean,
    sunshineSec: obs.sunshineSec != null ? Math.round(obs.sunshineSec) : null,
    daylightSec: obs.daylightSec != null ? Math.round(obs.daylightSec) : null,
    precipSum: obs.precipSum,
    pressureMean: obs.pressureMean,
    pressureDelta: obs.pressureDelta,
    humidityMean: obs.humidityMean,
    cloudMean: obs.cloudMean,
    weatherCode: obs.weatherCode,
    fetchedAt: new Date(),
  };
  await prisma.environmentContext.upsert({
    where: { userId_date: { userId, date: obs.date } },
    create: { userId, date: obs.date, ...data },
    update: data,
  });
}
