/**
 * v1.10.0 — computed scores (WX-E). The Strain score ENGINE + persistence.
 *
 * A daily cardio-load proxy (0–100, higher = more training strain) built
 * from the per-workout heart-rate series (`WorkoutSamples`, WX-D) plus
 * active-energy burned (`ACTIVE_ENERGY_BURNED`).
 *
 * CARDIO-LOAD MODEL — Banister's TRIMP (Training Impulse).
 * For each workout's HR series we compute the gender-weighted exponential
 * TRIMP:
 *
 *     TRIMP = Σ (Δt_min · HRr · 0.64 · e^(1.92 · HRr))     (men)
 *     TRIMP = Σ (Δt_min · HRr · 0.86 · e^(1.67 · HRr))     (women)
 *
 *   where HRr = (HR − HRrest) / (HRmax − HRrest) is the fractional
 *   heart-rate reserve per sample, Δt_min the minutes that sample
 *   represents, HRmax the age-predicted maximum (Tanaka 2001:
 *   208 − 0.7·age), and HRrest the user's resting heart rate.
 *
 * Standard: Banister EW, "Modeling Elite Athletic Performance" (1991);
 * the gender-weighted exponential form is from Morton, Fitz-Clarke &
 * Banister 1990, J. Appl. Physiol. 69(3):1171–1177. Tanaka HRmax:
 * Tanaka, Monahan & Seals 2001, J. Am. Coll. Cardiol. 37(1):153–156.
 *
 * The per-workout TRIMP values are summed across the scored day to a
 * day-total TRIMP, then mapped to the 0–100 scale by a saturating curve
 * anchored at a reference daily load (`STRAIN_TRIMP_REFERENCE` ≈ a hard
 * hour). Days with NO usable HR series but WITH active energy fall back to
 * an active-energy-only proxy so a "logged but no series" workout still
 * registers some strain (clearly the weaker signal — the provenance records
 * which path produced the score).
 *
 * Honest confidence: the score is only stored when the day carried at least
 * one workout HR series with usable samples OR a non-trivial active-energy
 * total AND the user profile yields an HRmax (needs age) + a resting HR.
 * Below that the engine returns `insufficient` and NO row is written.
 *
 * Row shape (identical posture to the Recovery + Stress scores):
 *   - `type   = STRAIN_SCORE`
 *   - `source = COMPUTED`
 *   - `unit   = "score"`
 *   - `value  = 0..100`
 *   - `externalId = strain:YYYY-MM-DD`
 *
 * The score is descriptive — a daily training-load proxy, NOT a clinical
 * assessment, and it is excluded from the doctor PDF. Server-only — runs
 * from the nightly pg-boss job in `src/lib/jobs/strain-score.ts`.
 */
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";
import { getAgeFromDateOfBirth } from "@/lib/analytics/pulse-targets";

/** The per-day idempotency-key prefix for a stored Strain score row. */
export const STRAIN_SCORE_EXTERNAL_ID_PREFIX = "strain:";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Reference day-total TRIMP that maps to a high (but not pinned) strain.
 * ~150 TRIMP is a hard ~hour of threshold work; the saturating map sends a
 * day at this load near the top of the band, with very heavy days pinned at
 * 100.
 */
export const STRAIN_TRIMP_REFERENCE = 150;

/**
 * Reference daily active-energy (kcal) for the HR-series-less fallback. A
 * busy active day (~600 kcal active) maps near the top of the band. The
 * fallback is intentionally the weaker signal — it has no intensity
 * distribution, only a volume total.
 */
export const STRAIN_ACTIVE_ENERGY_REFERENCE = 600;

/** The UTC calendar day a `now` falls in, as `YYYY-MM-DD`. */
export function strainDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The full `externalId` for a given day's Strain score row. */
export function strainExternalId(now: Date): string {
  return `${STRAIN_SCORE_EXTERNAL_ID_PREFIX}${strainDayKey(now)}`;
}

/** Noon UTC on the scored day — same convention as the other scores. */
export function strainMeasuredAt(now: Date): Date {
  return new Date(`${strainDayKey(now)}T12:00:00.000Z`);
}

/** Tanaka 2001 age-predicted maximum heart rate. */
export function tanakaHrMax(ageYears: number): number {
  return 208 - 0.7 * ageYears;
}

interface HrSample {
  t: string;
  hr?: number;
}

/**
 * Banister gender-weighted exponential TRIMP for one workout HR series.
 * Integrates fractional-HR-reserve over the inter-sample intervals. Samples
 * with no `hr`, or with an out-of-range fractional reserve, contribute
 * zero. Returns 0 for a series with fewer than two usable HR samples (no
 * interval to integrate). Pure — exported for unit testing.
 */
export function banisterTrimp(
  samples: readonly HrSample[],
  hrRest: number,
  hrMax: number,
  sex: "MALE" | "FEMALE" | null,
): number {
  if (hrMax <= hrRest) return 0;
  // Morton/Fitz-Clarke/Banister gender weights; the unisex default uses the
  // male coefficients (the more common watch-cohort assumption) when sex is
  // unknown.
  const a = sex === "FEMALE" ? 0.86 : 0.64;
  const b = sex === "FEMALE" ? 1.67 : 1.92;

  const usable = samples
    .filter((s) => typeof s.hr === "number" && Number.isFinite(s.hr))
    .map((s) => ({ t: Date.parse(s.t), hr: s.hr as number }))
    .filter((s) => Number.isFinite(s.t))
    .sort((x, y) => x.t - y.t);
  if (usable.length < 2) return 0;

  let trimp = 0;
  for (let i = 1; i < usable.length; i++) {
    const dtMin = (usable[i].t - usable[i - 1].t) / 60_000;
    if (dtMin <= 0) continue;
    // Use the interval's mean HR for the reserve fraction.
    const meanHr = (usable[i].hr + usable[i - 1].hr) / 2;
    let hrr = (meanHr - hrRest) / (hrMax - hrRest);
    if (!Number.isFinite(hrr)) continue;
    if (hrr <= 0) continue; // below resting → no training impulse.
    if (hrr > 1) hrr = 1; // clamp a spurious over-max sample.
    trimp += dtMin * hrr * a * Math.exp(b * hrr);
  }
  return trimp;
}

/**
 * Saturating map of a non-negative load to 0–100 against a reference. Uses
 * `1 − e^(−x/ref)` scaled to 100 so the score rises steeply at low load and
 * saturates toward 100 for very heavy days — never pinned exactly at 100
 * until the load is well above the reference. Pure.
 */
export function saturateToScore(load: number, reference: number): number {
  if (!(load > 0) || !(reference > 0)) return 0;
  const score = 100 * (1 - Math.exp(-load / reference));
  return Math.max(0, Math.min(100, Math.round(score)));
}

export interface StrainComputeResult {
  /** The 0..100 score to persist, or null when the inputs gate. */
  score: number | null;
  /** Why the result gated / which path produced the score. */
  reason:
    | "trimp"
    | "active_energy_fallback"
    | "insufficient_profile"
    | "insufficient_inputs";
  /** Day-total TRIMP (0 when no usable HR series). */
  dayTrimp: number;
  /** Day-total active energy (kcal). */
  dayActiveEnergy: number;
  /** Workouts with a usable HR series on the day. */
  workoutsWithSeries: number;
}

export interface StrainProfile {
  ageYears: number | null;
  sex: "MALE" | "FEMALE" | null;
}

/**
 * Compute the Strain score for one user as of `now`. Reads the day's
 * workouts (+ HR series) and active-energy total, computes day-total TRIMP,
 * and maps it to 0–100. Falls back to an active-energy-only proxy when no
 * HR series is usable. Pure of persistence. Gates (null score) when the
 * profile yields no HRmax / resting HR, or there is no usable input at all.
 */
export async function computeStrainScore(
  prisma: PrismaClient,
  userId: string,
  profile: StrainProfile,
  hrRest: number | null,
  now: Date,
): Promise<StrainComputeResult> {
  const dayKey = strainDayKey(now);
  const dayStart = new Date(`${dayKey}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + MS_PER_DAY);

  // Day-total active energy first — it is the fallback signal and cheap.
  const energyRows = await prisma.measurement.findMany({
    where: {
      userId,
      type: "ACTIVE_ENERGY_BURNED" as MeasurementType,
      deletedAt: null,
      measuredAt: { gte: dayStart, lt: dayEnd },
    },
    select: { value: true },
    take: 5000,
  });
  const dayActiveEnergy = energyRows.reduce((s, r) => s + r.value, 0);

  // The day's workouts + their HR series.
  const workouts = await prisma.workout.findMany({
    where: { userId, startedAt: { gte: dayStart, lt: dayEnd } },
    select: { id: true, samples: { select: { samples: true } } },
    take: 100,
  });

  const hrMax =
    profile.ageYears != null ? tanakaHrMax(profile.ageYears) : null;
  const canTrimp = hrMax != null && hrRest != null && hrMax > hrRest;

  let dayTrimp = 0;
  let workoutsWithSeries = 0;
  if (canTrimp) {
    for (const w of workouts) {
      const raw = w.samples?.samples;
      if (!Array.isArray(raw)) continue;
      const series = raw as unknown as HrSample[];
      const trimp = banisterTrimp(series, hrRest!, hrMax!, profile.sex);
      if (trimp > 0) {
        dayTrimp += trimp;
        workoutsWithSeries += 1;
      }
    }
  }

  if (dayTrimp > 0) {
    return {
      score: saturateToScore(dayTrimp, STRAIN_TRIMP_REFERENCE),
      reason: "trimp",
      dayTrimp,
      dayActiveEnergy,
      workoutsWithSeries,
    };
  }

  // No usable HR series. Fall back to the active-energy-only proxy when
  // there is a non-trivial active-energy total. A profile with no HRmax /
  // resting HR can still get this fallback because it needs neither.
  if (dayActiveEnergy > 0) {
    return {
      score: saturateToScore(dayActiveEnergy, STRAIN_ACTIVE_ENERGY_REFERENCE),
      reason: "active_energy_fallback",
      dayTrimp: 0,
      dayActiveEnergy,
      workoutsWithSeries: 0,
    };
  }

  // Neither a usable HR series nor active energy → nothing to score. If the
  // only reason TRIMP was unavailable is the profile, say so for the log.
  return {
    score: null,
    reason:
      workouts.length > 0 && !canTrimp
        ? "insufficient_profile"
        : "insufficient_inputs",
    dayTrimp: 0,
    dayActiveEnergy,
    workoutsWithSeries: 0,
  };
}

/**
 * Build the Strain profile (age + sex) and resting HR from the user row +
 * the latest resting-HR reading. `prisma` is the (worker) client.
 */
export async function loadStrainInputs(
  prisma: PrismaClient,
  userId: string,
  now: Date,
): Promise<{ profile: StrainProfile; hrRest: number | null }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { dateOfBirth: true, gender: true },
  });
  const sex =
    user?.gender === "MALE" || user?.gender === "FEMALE" ? user.gender : null;
  const profile: StrainProfile = {
    ageYears: getAgeFromDateOfBirth(user?.dateOfBirth ?? null),
    sex,
  };

  // Most recent resting-HR reading within a 30-day window — the HRrest input
  // for the TRIMP reserve fraction. Null when the user has no recent RHR.
  const since = new Date(now.getTime() - 30 * MS_PER_DAY);
  const rhr = await prisma.measurement.findFirst({
    where: {
      userId,
      type: "RESTING_HEART_RATE" as MeasurementType,
      deletedAt: null,
      measuredAt: { gte: since },
    },
    orderBy: { measuredAt: "desc" },
    select: { value: true },
  });
  return { profile, hrRest: rhr?.value ?? null };
}

export interface PersistStrainResult {
  outcome: "stored" | "insufficient";
  score: number | null;
  reason: StrainComputeResult["reason"];
}

/**
 * Compute + persist one user's Strain score for the `now` day. Upserts on
 * the `(userId, type, source, externalId)` key (idempotent per user per
 * day). Writes NOTHING when the inputs gate.
 */
export async function persistStrainScore(
  prisma: PrismaClient,
  userId: string,
  now: Date,
): Promise<PersistStrainResult> {
  const { profile, hrRest } = await loadStrainInputs(prisma, userId, now);
  const { score, reason } = await computeStrainScore(
    prisma,
    userId,
    profile,
    hrRest,
    now,
  );

  if (score === null) {
    return { outcome: "insufficient", score: null, reason };
  }

  const externalId = strainExternalId(now);
  const measuredAt = strainMeasuredAt(now);

  await prisma.measurement.upsert({
    where: {
      userId_type_source_externalId: {
        userId,
        type: "STRAIN_SCORE",
        source: "COMPUTED",
        externalId,
      },
    },
    create: {
      userId,
      type: "STRAIN_SCORE",
      source: "COMPUTED",
      value: score,
      unit: "score",
      measuredAt,
      externalId,
    },
    update: {
      value: score,
      measuredAt,
    },
  });

  return { outcome: "stored", score, reason };
}
