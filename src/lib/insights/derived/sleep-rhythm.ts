/**
 * v1.17.0 — sleep-rhythm assembler (server-authoritative).
 *
 * The one place that turns a user's raw `SLEEP_DURATION` rows into the two
 * timing signals the Sleep page + the iOS client + the dashboard render:
 *
 *   - cumulative SLEEP DEBT over the rolling window (`computeSleepDebt`), and
 *   - MCTQ CHRONOTYPE + social jetlag (`computeChronotype`).
 *
 * ONE ENGINE, NO DUPLICATION
 * --------------------------
 * The per-night `asleepMinutes` and `midpointMinutes` come from the SAME
 * canonical reconstruction the Sleep Score reads — `reconstructNights`
 * (`sleep-score.ts`), which itself adapts `reconstructSleepNights`
 * (`sleep-night.ts`). This module does NOT re-cluster sessions, re-dedup
 * writers, or re-derive a midpoint; it maps the canonical night output onto
 * the two foundation modules' inputs and forwards the resolved `needMinutes`.
 * The math lives entirely in `sleep-debt.ts` / `chronotype.ts` — this file is
 * the adapter + DB read + day-type resolver, nothing else. Because the inputs
 * are the canonical totals, the debt headline and the chronotype band can
 * never contradict the dashboard / hypnogram / Sleep Score for the same night.
 *
 * DAY-TYPE SIGNAL (free vs work)
 * ------------------------------
 * Chronotype's MSF needs each night tagged free or work, and the app has no
 * work calendar. The documented DEFAULT is calendar-based: a night whose WAKE
 * day falls on Saturday or Sunday (in the user's timezone) is "free"; every
 * other night is "work". This mirrors the MCTQ assumption that weekends are
 * the alarm-free days for a standard work week — surfaced as a modelling
 * assumption, not a hidden constant. When a future per-night logged day-type
 * exists it overrides this default; until then weekday/weekend is the floor.
 *
 * Server-only — reads raw `SLEEP_DURATION` rows via Prisma, bounded to the
 * window. The DTO is the shared wire shape the route, the dashboard summary,
 * and the iOS serializer all emit identically.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { loadBaselineProfile } from "./baseline";
import {
  reconstructNights,
  sleepNeedMinutes,
} from "./sleep-score";
import {
  computeSleepDebt,
  type SleepDebtNight,
  type SleepDebtResult,
} from "./sleep-debt";
import {
  computeChronotype,
  type ChronotypeNight,
  type ChronotypeResult,
} from "./chronotype";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Trailing read window in days. The sleep-debt rolling window is 14 nights and
 * chronotype wants a few weeks of free-day samples; 42 days (six weeks) gives
 * the debt window full coverage and ~12 weekend nights for a stable MSF while
 * staying a bounded per-stage read.
 */
const DEFAULT_WINDOW_DAYS = 42;

/** Wire DTO for the cumulative sleep debt — see `SleepDebtResult`. */
export interface SleepDebtDto {
  state: "partial" | "ready";
  debtMinutes: number;
  needMinutes: number;
  nightsCounted: number;
  windowNights: number;
  nightsUntilReady: number;
}

/** Wire DTO for the MCTQ chronotype — see `ChronotypeResult`. */
export interface ChronotypeDto {
  state: "learning" | "ready";
  msfMinutes: number | null;
  msfScMinutes: number | null;
  band:
    | "extreme_early"
    | "early"
    | "intermediate"
    | "late"
    | "extreme_late"
    | null;
  socialJetlagMinutes: number | null;
  freeNightsCounted: number;
  workNightsCounted: number;
  freeNightsUntilReady: number;
}

/** The combined sleep-rhythm DTO — both signals in one read. */
export interface SleepRhythmDto {
  sleepDebt: SleepDebtDto;
  chronotype: ChronotypeDto;
}

/**
 * Day type of a night from its WAKE day's weekday in the user's timezone:
 * Saturday / Sunday → "free", else "work". The documented calendar default
 * (no work calendar exists). `night` is the YYYY-MM-DD wake-day key.
 */
export function defaultDayType(night: string, tz: string): "work" | "free" {
  // Anchor at local noon of the wake day so the weekday read is immune to the
  // tz offset and DST — noon never crosses a day boundary in any zone.
  const noon = new Date(`${night}T12:00:00Z`);
  const weekday = wallClockInTz(noon, tz).weekday; // 0 = Sun … 6 = Sat
  return weekday === 0 || weekday === 6 ? "free" : "work";
}

function toDebtDto(r: SleepDebtResult): SleepDebtDto {
  return {
    state: r.state,
    debtMinutes: r.debtMinutes,
    needMinutes: r.needMinutes,
    nightsCounted: r.nightsCounted,
    windowNights: r.windowNights,
    nightsUntilReady: r.nightsUntilReady,
  };
}

function toChronotypeDto(r: ChronotypeResult): ChronotypeDto {
  return {
    state: r.state,
    msfMinutes: r.msfMinutes,
    msfScMinutes: r.msfScMinutes,
    band: r.band,
    socialJetlagMinutes: r.socialJetlagMinutes,
    freeNightsCounted: r.freeNightsCounted,
    workNightsCounted: r.workNightsCounted,
    freeNightsUntilReady: r.freeNightsUntilReady,
  };
}

export interface SleepRhythmOpts {
  windowDays?: number;
  now?: Date;
  /** Pin the IANA zone in tests; omit to resolve the user's stored zone. */
  tz?: string;
}

/** A reconstructed night carrying the canonical asleep total + wall-clock midpoint. */
export interface RhythmNight {
  night: string;
  asleepMinutes: number;
  /** Sleep midpoint as minutes-of-day (0..1439), or null when undefined. */
  midpoint: number | null;
}

/**
 * Pure DTO assembler from already-reconstructed nights. The route reads + runs
 * the canonical reconstruction; the dashboard summary reuses its own loaded
 * rows. Both feed the SAME foundation modules here so the values are identical
 * — this is the one place the day-type default + the two `compute*` calls live.
 *
 * `nights` must already be the canonical engine's output (asleep + midpoint);
 * this function does NOT reconstruct. `needMinutes` is the age-resolved need.
 */
export function computeSleepRhythmFromNights(
  nights: readonly RhythmNight[],
  needMinutes: number,
  tz: string,
): SleepRhythmDto {
  const scorable = nights.filter((n) => n.asleepMinutes > 0);

  const debtNights: SleepDebtNight[] = scorable.map((n) => ({
    night: n.night,
    asleepMinutes: n.asleepMinutes,
  }));
  const sleepDebt = computeSleepDebt(debtNights, needMinutes);

  const chronoNights: ChronotypeNight[] = scorable
    .filter((n) => n.midpoint != null)
    .map((n) => ({
      night: n.night,
      midpointMinutes: n.midpoint as number,
      asleepMinutes: n.asleepMinutes,
      dayType: defaultDayType(n.night, tz),
    }));
  const chronotype = computeChronotype(chronoNights);

  return {
    sleepDebt: toDebtDto(sleepDebt),
    chronotype: toChronotypeDto(chronotype),
  };
}

/**
 * Read raw sleep rows, reconstruct nights via the canonical engine, and
 * compute the sleep-debt + chronotype DTO. Returns the calm partial/learning
 * states (never asserts off thin data) when the window is short. The midpoint
 * + asleep totals are the canonical engine's — no second reconstruction.
 */
export async function buildSleepRhythm(
  userId: string,
  opts: SleepRhythmOpts = {},
): Promise<SleepRhythmDto> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? (await resolveUserTimezone(userId));
  const [priorityJson, profile] = await Promise.all([
    loadUserSourcePriority(userId),
    loadBaselineProfile(prisma, userId),
  ]);
  const since = new Date(now.getTime() - windowDays * MS_PER_DAY);

  const rows = await prisma.measurement.findMany({
    where: {
      userId,
      type: "SLEEP_DURATION" satisfies MeasurementType,
      deletedAt: null,
      measuredAt: { gte: since },
    },
    orderBy: { measuredAt: "asc" },
    // source + deviceType feed the canonical writer-dedup so a multi-source
    // night is counted ONCE, matching every other sleep surface.
    select: {
      value: true,
      measuredAt: true,
      sleepStage: true,
      source: true,
      deviceType: true,
    },
  });

  // Canonical reconstruction (session-clustering, wake-day keying, writer
  // dedup) → per-night asleep total + wall-clock midpoint. Same engine as the
  // Sleep Score; we never re-derive a midpoint here.
  const nights = reconstructNights(rows, tz, priorityJson).filter(
    (n) => n.asleepMinutes > 0,
  );

  const needMinutes = sleepNeedMinutes(profile.ageYears);
  return computeSleepRhythmFromNights(nights, needMinutes, tz);
}
