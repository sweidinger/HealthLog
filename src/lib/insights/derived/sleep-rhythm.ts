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
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { loadBaselineProfile } from "./baseline";
import { reconstructNights, sleepNeedMinutes } from "./sleep-score";
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
 * Day type of a night from its WAKE day's weekday: Saturday / Sunday → "free",
 * else "work". The documented calendar default (no work calendar exists).
 *
 * `night` is ALREADY the YYYY-MM-DD wake-day key in the user's timezone (the
 * canonical engine keyed it with `userDayKey`), so its weekday is a pure
 * property of those calendar digits — there is no second tz conversion to do.
 * Parsing the digits and taking `getUTCDay()` is timezone-independent: a UTC
 * instant at midnight of the same Y-M-D reads back the identical weekday in
 * every zone, so this is correct for far-east (UTC+13/+14) users too — the
 * earlier "noon-UTC instant + wallClockInTz" form shifted the weekday by a day
 * there.
 */
export function defaultDayType(night: string): "work" | "free" {
  const [y, m, d] = night.split("-").map(Number);
  if (!y || !m || !d) return "work";
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sun … 6 = Sat
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
 * Chronotype look-back in nights. The helper caps its OWN chronotype input to
 * the trailing `CHRONOTYPE_WINDOW_NIGHTS` so the result is a pure function of
 * the most-recent N nights — NOT of however many nights a given caller happened
 * to pass. Without this cap a caller that hands in a year of nights (the
 * dashboard summary's 365-day read) would average MSF/MSFsc/social-jetlag over
 * a different sample than a caller passing six weeks (the route), and the two
 * surfaces would disagree. `computeSleepDebt` already self-caps to 14 nights,
 * so the debt headline is source-window-independent for free; this brings the
 * chronotype to the same guarantee. 42 nights (six weeks) gives ~12 weekend
 * nights for a stable free-day MSF.
 */
const CHRONOTYPE_WINDOW_NIGHTS = 42;

/**
 * Pure DTO assembler from already-reconstructed nights. The route reads + runs
 * the canonical reconstruction; the dashboard summary reuses its own loaded
 * rows. Both feed the SAME foundation modules here so the values are identical
 * REGARDLESS of how many nights each caller passes — the helper owns the
 * chronotype window cap, so a 42-night and a 365-night caller get the same DTO.
 * This is the one place the window cap + day-type default + the two `compute*`
 * calls live.
 *
 * `nights` must already be the canonical engine's output (asleep + midpoint);
 * this function does NOT reconstruct. `needMinutes` is the age-resolved need.
 */
export function computeSleepRhythmFromNights(
  nights: readonly RhythmNight[],
  needMinutes: number,
): SleepRhythmDto {
  // Sort ascending by wake-day key so "trailing N" is well-defined regardless
  // of the caller's input order, then keep only scorable nights.
  const scorable = [...nights]
    .filter((n) => n.asleepMinutes > 0)
    .sort((a, b) => (a.night < b.night ? -1 : a.night > b.night ? 1 : 0));

  // Debt self-caps to its own 14-night window internally; pass every scorable
  // night and let the module slice.
  const debtNights: SleepDebtNight[] = scorable.map((n) => ({
    night: n.night,
    asleepMinutes: n.asleepMinutes,
  }));
  const sleepDebt = computeSleepDebt(debtNights, needMinutes);

  // Chronotype has no internal window — cap HERE to the trailing N nights so
  // the value is a function of the recent rhythm, not the caller's read span.
  const chronoNights: ChronotypeNight[] = scorable
    .filter((n) => n.midpoint != null)
    .slice(-CHRONOTYPE_WINDOW_NIGHTS)
    .map((n) => ({
      night: n.night,
      midpointMinutes: n.midpoint as number,
      asleepMinutes: n.asleepMinutes,
      dayType: defaultDayType(n.night),
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
  // Sleep Score; we never re-derive a midpoint here. The helper owns the
  // scorable-night filter + the window cap, so we hand it the raw output.
  const nights = reconstructNights(rows, tz, priorityJson);

  const needMinutes = sleepNeedMinutes(profile.ageYears);
  return computeSleepRhythmFromNights(nights, needMinutes);
}
