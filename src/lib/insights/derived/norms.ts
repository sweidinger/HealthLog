/**
 * v1.10.0 — age/sex reference-range tables (the F1 enabler).
 *
 * The generic assessment registry (`metric-status-registry.ts`) already
 * threads a coarse, demographic-flat `normalRange` per metric and already
 * passes `age` + `sex` into the prompt. This module SHARPENS that slot:
 * `lookupNormalRange(metricId, ageYears, sex)` returns an age/sex-adjusted
 * band when a cited standard supports one, falling back to `null` so the
 * caller keeps the existing flat anchor (additive, behind the existing
 * behaviour — never a regression).
 *
 * Strictly age + sex. NO ancestry / ethnicity / region-of-birth ranges —
 * that is medically contentious and a data category HealthLog does not
 * collect (the registry already states this stance).
 *
 * Cited standards (one per table):
 *   - VO₂max percentile norms — Cooper Institute / FRIEND registry:
 *     Kaminsky et al. 2015, "Reference Standards for Cardiorespiratory
 *     Fitness Measured With Cardiopulmonary Exercise Testing", Mayo Clinic
 *     Proceedings 90(11):1515–1523. (The 50th-percentile age×sex band.)
 *   - Resting heart rate by age — standard physiology / population
 *     reference (adult resting-HR narrows with the AHA 60–100 bpm anchor;
 *     children/adolescents run higher — Fleming et al. 2011, Lancet
 *     377(9770):1011–1018, normal-range HR centiles by age).
 *   - Respiratory rate by age — clinical reference (WHO/PALS adult vs
 *     paediatric ranges).
 *   - Six-minute-walk distance — a published REGRESSION (not a bracket
 *     table): Enright & Sherrill 1998, "Reference Equations for the
 *     Six-Minute Walk in Healthy Adults", Am J Respir Crit Care Med
 *     158(5):1384–1387; the test itself standardised by ATS 2002,
 *     "ATS Statement: Guidelines for the Six-Minute Walk Test",
 *     Am J Respir Crit Care Med 166(1):111–117. Surfaced as a
 *     percent-of-predicted re-frame, never a HealthLog-derived equation.
 *
 * Client-safe — pure data + a pure lookup, no server imports.
 */
import type { MetricStatusMetricId } from "@/lib/insights/metric-status-registry";

/** Profile sex as stored on `User.gender` ("MALE" | "FEMALE" | null). */
export type NormSex = "MALE" | "FEMALE" | null | undefined;

/** A reference band — same shape as `MetricNormalRange`. */
export interface NormRange {
  low: number;
  high: number;
}

/** One age-bracketed row, optionally sex-specific. */
interface NormRow {
  /** Inclusive lower age bound (years). */
  minAge: number;
  /** Inclusive upper age bound (years). */
  maxAge: number;
  /** Sex this row applies to; `null` = applies to either. */
  sex: "MALE" | "FEMALE" | null;
  range: NormRange;
}

/**
 * VO₂max 50th-percentile bands (mL/(kg·min)) by decade × sex — derived
 * from the FRIEND registry (Kaminsky et al. 2015). The band brackets the
 * "Good" placement for the age×sex cell; the assessment leans on the
 * user's own trend, this only sharpens the population anchor.
 */
const VO2_MAX_NORMS: NormRow[] = [
  { minAge: 20, maxAge: 29, sex: "MALE", range: { low: 42, high: 53 } },
  { minAge: 30, maxAge: 39, sex: "MALE", range: { low: 39, high: 49 } },
  { minAge: 40, maxAge: 49, sex: "MALE", range: { low: 35, high: 45 } },
  { minAge: 50, maxAge: 59, sex: "MALE", range: { low: 31, high: 41 } },
  { minAge: 60, maxAge: 120, sex: "MALE", range: { low: 27, high: 37 } },
  { minAge: 20, maxAge: 29, sex: "FEMALE", range: { low: 36, high: 46 } },
  { minAge: 30, maxAge: 39, sex: "FEMALE", range: { low: 33, high: 43 } },
  { minAge: 40, maxAge: 49, sex: "FEMALE", range: { low: 30, high: 39 } },
  { minAge: 50, maxAge: 59, sex: "FEMALE", range: { low: 26, high: 35 } },
  { minAge: 60, maxAge: 120, sex: "FEMALE", range: { low: 22, high: 31 } },
];

/**
 * Resting-HR normal bands by age (bpm). Sex-agnostic — the adult band is
 * the AHA 60–100 anchor; younger ages run higher (Fleming et al. 2011
 * normal-range centiles). Direction is `lower-better` within the band.
 */
const RESTING_HEART_RATE_NORMS: NormRow[] = [
  { minAge: 0, maxAge: 1, sex: null, range: { low: 100, high: 160 } },
  { minAge: 2, maxAge: 5, sex: null, range: { low: 80, high: 120 } },
  { minAge: 6, maxAge: 12, sex: null, range: { low: 70, high: 110 } },
  { minAge: 13, maxAge: 17, sex: null, range: { low: 60, high: 100 } },
  { minAge: 18, maxAge: 120, sex: null, range: { low: 50, high: 90 } },
];

/**
 * Respiratory-rate normal bands by age (breaths/min). Sex-agnostic —
 * clinical reference (WHO/PALS): adult 12–20, paediatric ranges run
 * higher.
 */
const RESPIRATORY_RATE_NORMS: NormRow[] = [
  { minAge: 0, maxAge: 1, sex: null, range: { low: 30, high: 60 } },
  { minAge: 2, maxAge: 5, sex: null, range: { low: 20, high: 30 } },
  { minAge: 6, maxAge: 12, sex: null, range: { low: 18, high: 25 } },
  { minAge: 13, maxAge: 17, sex: null, range: { low: 12, high: 20 } },
  { minAge: 18, maxAge: 120, sex: null, range: { low: 12, high: 18 } },
];

/**
 * The norm tables, keyed by the assessment-registry metric id. A metric
 * absent from this map has no age/sex sharpening — the caller keeps the
 * flat registry anchor. Append a table here to lift another metric.
 */
const NORM_TABLES: Partial<Record<MetricStatusMetricId, NormRow[]>> = {
  VO2_MAX: VO2_MAX_NORMS,
  RESTING_HEART_RATE: RESTING_HEART_RATE_NORMS,
  RESPIRATORY_RATE: RESPIRATORY_RATE_NORMS,
};

/** The age a bracket row is anchored at for interpolation — its centre. */
function bracketCentre(row: NormRow): number {
  return (row.minAge + row.maxAge) / 2;
}

/**
 * Resolve the candidate rows for a profile sex: the sex-specific rows when
 * an exact match exists, else the sex-agnostic rows, else none. Returns the
 * rows ordered by bracket centre so the caller can interpolate across them.
 * `null` (rather than an empty array) signals "no honest band for this sex"
 * — a sex-specific-only table with no profile sex.
 */
function resolveSexRows(rows: NormRow[], sex: NormSex): NormRow[] | null {
  const exact = sex ? rows.filter((row) => row.sex === sex) : [];
  if (exact.length > 0) {
    return [...exact].sort((a, b) => bracketCentre(a) - bracketCentre(b));
  }
  const agnostic = rows.filter((row) => row.sex === null);
  if (agnostic.length > 0) {
    return [...agnostic].sort((a, b) => bracketCentre(a) - bracketCentre(b));
  }
  return null;
}

/**
 * Resolve the age/sex-adjusted reference band for a metric, or `null`
 * when no sharper band applies (unsupported metric, or demographics
 * absent). On `null` the caller keeps the existing flat `normalRange`
 * anchor — the enabler is strictly additive.
 *
 * Sex matching: a sex-specific table prefers the rows matching the profile
 * sex; when the profile sex is absent it falls back to the sex-agnostic
 * rows; a sex-specific-only table with no profile sex yields no honest band.
 *
 * Age handling: the bracket tables are coarse (decade / paediatric bands),
 * so a fractional age that lands near a bracket edge would otherwise read a
 * hard step at the boundary (e.g. 39.9 → 30s band, 40.0 → 40s band). Instead
 * each band is anchored at its bracket CENTRE and a fractional age is linearly
 * interpolated between the two adjacent centres — the band moves smoothly with
 * age. Below the youngest centre / above the oldest centre the nearest band is
 * held flat (clamp, never extrapolate), so the interpolated band always lies
 * within the span of the two cited bracket bands and the standard's provenance
 * stays accurate.
 */
export function lookupNormalRange(
  metricId: MetricStatusMetricId,
  ageYears: number | null | undefined,
  sex: NormSex,
): NormRange | null {
  if (ageYears == null || !Number.isFinite(ageYears) || ageYears < 0) {
    return null;
  }
  const table = NORM_TABLES[metricId];
  if (!table) return null;

  const rows = resolveSexRows(table, sex);
  if (!rows || rows.length === 0) return null;

  // Single band — no neighbour to interpolate against.
  if (rows.length === 1) return { ...rows[0].range };

  // Clamp below the youngest centre / above the oldest centre: hold the
  // nearest cited band flat rather than extrapolate past the table.
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (ageYears <= bracketCentre(first)) return { ...first.range };
  if (ageYears >= bracketCentre(last)) return { ...last.range };

  // Find the two adjacent brackets whose centres bracket the age, then blend
  // their ranges by the fractional position between the centres.
  for (let i = 0; i < rows.length - 1; i++) {
    const lo = rows[i];
    const hi = rows[i + 1];
    const loCentre = bracketCentre(lo);
    const hiCentre = bracketCentre(hi);
    if (ageYears >= loCentre && ageYears <= hiCentre) {
      const span = hiCentre - loCentre;
      const fraction = span > 0 ? (ageYears - loCentre) / span : 0;
      // Round to one decimal: the cited brackets are integer-valued and the
      // interpolated band reads tidily in the prompt + tile without losing the
      // smoothing across the boundary.
      const round1 = (n: number) => Math.round(n * 10) / 10;
      return {
        low: round1(lo.range.low + (hi.range.low - lo.range.low) * fraction),
        high: round1(lo.range.high + (hi.range.high - lo.range.high) * fraction),
      };
    }
  }

  // Defensive — the clamp + loop above cover every finite age in range.
  return { ...last.range };
}

/**
 * Enright & Sherrill 1998 predicted six-minute-walk distance (metres) for a
 * healthy adult. A published linear regression on age, height, weight, sex —
 * NOT a HealthLog-derived model:
 *   - Men:   6MWD = 7.57·height_cm − 5.02·age − 1.76·weight_kg − 309
 *   - Women: 6MWD = 2.11·height_cm − 2.29·weight_kg − 5.78·age + 667
 *
 * Returns `null` when the inputs the equation needs are absent, so the caller
 * surfaces the raw distance + trend without a fabricated placement (the
 * `fitness-age.ts` `band: null` discipline). Sex is required (the two
 * coefficient sets differ); height is required (the dominant term). Weight is
 * required for the published full equation — when it is missing we return
 * `null` rather than silently dropping the weight term, since the omission
 * would inflate the predicted distance.
 *
 * Pure. The equation is for adults; for ages below 18 the reference does not
 * apply and we return `null`. The Enright & Sherrill cohort was ages 40–80;
 * outside that range the linear equation extrapolates, so the caveat copy
 * flags the predicted value as an extrapolation for younger / older users.
 */
export function predictSixMinuteWalkDistance(
  ageYears: number | null | undefined,
  heightCm: number | null | undefined,
  weightKg: number | null | undefined,
  sex: NormSex,
): number | null {
  if (sex !== "MALE" && sex !== "FEMALE") return null;
  if (
    ageYears == null ||
    !Number.isFinite(ageYears) ||
    ageYears < 18 ||
    ageYears > 120
  ) {
    return null;
  }
  if (heightCm == null || !Number.isFinite(heightCm) || heightCm <= 0) {
    return null;
  }
  if (weightKg == null || !Number.isFinite(weightKg) || weightKg <= 0) {
    return null;
  }
  const predicted =
    sex === "MALE"
      ? 7.57 * heightCm - 5.02 * ageYears - 1.76 * weightKg - 309
      : 2.11 * heightCm - 2.29 * weightKg - 5.78 * ageYears + 667;
  // A non-positive prediction is physically meaningless — treat as no band.
  return predicted > 0 ? predicted : null;
}

/** `true` when an age/sex-sharpened band exists for the metric+profile. */
export function hasSharpenedNorm(
  metricId: MetricStatusMetricId,
  ageYears: number | null | undefined,
  sex: NormSex,
): boolean {
  return lookupNormalRange(metricId, ageYears, sex) !== null;
}
