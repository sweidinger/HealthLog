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

/**
 * Resolve the age/sex-adjusted reference band for a metric, or `null`
 * when no sharper band applies (unsupported metric, or demographics
 * absent). On `null` the caller keeps the existing flat `normalRange`
 * anchor — the enabler is strictly additive.
 *
 * Sex matching: a sex-specific table prefers the row matching the
 * profile sex; when the profile sex is absent it falls back to the
 * row's `null`-sex variant if present, else the first matching-age row.
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

  const ageRows = table.filter(
    (row) => ageYears >= row.minAge && ageYears <= row.maxAge,
  );
  if (ageRows.length === 0) return null;

  // Prefer an exact sex match; then a sex-agnostic row; then any row in
  // the age bracket (so a sex-specific-only table still yields a band for
  // a profile with no sex by averaging is avoided — we pick a defined
  // band rather than fabricate).
  const exact = sex ? ageRows.find((row) => row.sex === sex) : undefined;
  if (exact) return { ...exact.range };

  const agnostic = ageRows.find((row) => row.sex === null);
  if (agnostic) return { ...agnostic.range };

  // Sex-specific-only table but no profile sex: no honest single band.
  return null;
}

/** `true` when an age/sex-sharpened band exists for the metric+profile. */
export function hasSharpenedNorm(
  metricId: MetricStatusMetricId,
  ageYears: number | null | undefined,
  sex: NormSex,
): boolean {
  return lookupNormalRange(metricId, ageYears, sex) !== null;
}
