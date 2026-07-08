/**
 * Server-side aggregator for doctor-report data.
 *
 * Single source of truth for the aggregated payload consumed by both
 * `/api/doctor-report` (JSON, client renders PDF) and
 * `/api/doctor-report/pdf` (server-rendered PDF). Keeps the two endpoints
 * structurally identical so visual parity between client- and server-rendered
 * PDFs is guaranteed by construction, not by drift-prone copy-paste.
 */

import { prisma } from "@/lib/db";
import {
  getEffectiveRange,
  type ThresholdOverridesJson,
} from "@/lib/analytics/effective-range";
import {
  resolveGlucoseUnit,
  thresholdMetricForContext,
  type GlucoseUnit,
} from "@/lib/glucose";
import {
  computeGlucoseClinicalMetrics,
  type GlucoseClinicalMetrics,
} from "@/lib/analytics/glucose-metrics";
import type {
  GlucoseContext,
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/client";
import { pickCanonicalSourceRows } from "@/lib/analytics/source-priority";
import { getEvent } from "@/lib/logging/context";
import { readNote } from "@/lib/crypto/note-cipher";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { metricKeyForType } from "@/lib/measurements/cumulative-day-sum";
import { userDayKey } from "@/lib/tz/resolver";
import { resolveCanonicalRecovery } from "@/lib/insights/derived/recovery-resolve";
import {
  reconstructSleepNights,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";
import {
  DEFAULT_DOCTOR_REPORT_PREFS,
  type DoctorReportPrefs,
} from "@/lib/validations/doctor-report-prefs";
import { buildCycleExportSummary } from "@/lib/cycle/export-data";
import { resolveModuleMap, type ModuleKey } from "@/lib/modules/gate";
import {
  buildComplianceMedicationContext,
  lastNonSkippedTakenAt,
  tallyComplianceFromLedger,
  SCHEDULE_COMPLIANCE_SELECT,
  type ComplianceSchedule,
  type IntakeEvent,
  type MedicationPauseEraLike,
} from "@/lib/analytics/compliance";
import type { ScheduleRevisionLike } from "@/lib/medications/scheduling/schedule-eras";

export interface DoctorReportStats {
  avg: number;
  min: number;
  max: number;
  count: number;
  latest: number;
}

export interface DoctorReportCompliance {
  total: number;
  taken: number;
  skipped: number;
  missed: number;
}

/**
 * Canonical adherence-rate rounding for the doctor-report export surfaces.
 *
 * The PDF table, the PDF clinical-summary headline, the FHIR adherence
 * Observation, and the GLP-1 block all derive the rate from the SAME ledger
 * denominator (`taken / total`, `total = taken + missed`). They MUST round it
 * the same way the app does so a clinician comparing the export to the in-app
 * card never sees a presentational divergence (87 % on the card, 87.3 % on the
 * PDF). The app convention is `round(100 · taken / denominator)` capped at 100
 * (see `dose-history-ledger-compute.ts` + `tallyComplianceFromLedger`) — an
 * integer percent. This is the one source of truth for every export surface.
 *
 * Returns `null` when `total <= 0` so callers render the "no expected dose"
 * placeholder instead of a misleading `0` or `100`.
 */
export function adherenceRatePercent(
  taken: number,
  total: number,
): number | null {
  if (total <= 0) return null;
  return Math.min(100, Math.round((taken / total) * 100));
}

export interface DoctorReportMood {
  avg: number;
  min: number;
  max: number;
  count: number;
  distribution: Record<number, number>;
}

export interface DoctorReportData {
  /**
   * Reporting period bounds. `start` and `end` are ISO timestamps; `days` is
   * the inclusive day-count between the two (rounded up) so existing callers
   * that displayed "last N days" continue to work without a UI rewrite.
   */
  period: { days: number; since: string; start: string; end: string };
  patient: {
    username: string | null;
    dateOfBirth: string | null;
    gender: string | null;
    heightCm: number | null;
    // v1.7.0 — optional patient-identity fields for the export cover +
    // FHIR Patient. `fullName` + `insurerName` are plaintext columns; the
    // KVNR is NOT carried here (it's encrypted at rest and decrypted by
    // the route, then handed to the builders separately). Optional in the
    // type so pre-v1.7.0 fixtures that omit them still typecheck — the
    // renderer treats absent and null identically.
    fullName?: string | null;
    insurerName?: string | null;
    // v1.8.6 — German insurer institution number (IKNR), plaintext. Carried
    // here for the FHIR `Coverage` payor Organization identifier. Optional
    // so pre-v1.8.6 fixtures still typecheck.
    insurerIkNumber?: string | null;
  };
  /**
   * Free-text practice / clinic name printed on the cover. `null` omits the
   * line entirely. Persisted as a user preference (see
   * `User.lastReportPracticeName`).
   */
  practiceName: string | null;
  measurements: Record<string, Array<{ value: number; measuredAt: string }>>;
  stats: Record<string, DoctorReportStats>;
  glucoseStats: Record<string, DoctorReportStats>;
  glucoseRanges: Record<string, { min: number; max: number }>;
  glucoseUnit: GlucoseUnit;
  /**
   * v1.17.0 — server-authoritative glucose clinical panel over the report
   * period (TIR / GMI / estimated A1C / CV% + the advanced J-index + LBGI/HBGI
   * tier), computed by `computeGlucoseClinicalMetrics` so the PDF/FHIR export
   * carries the SAME numbers the insights panel and the coach show. Values are
   * canonical mg/dL; `glucoseUnit` drives display conversion at render. Carried
   * as a spot-reading estimate (`isSpotEstimate: true`), gated by
   * `stillLearning` when the period is too thin to assert clinically.
   */
  glucoseClinical: GlucoseClinicalMetrics;
  bmi: number | null;
  compliance: Record<string, DoctorReportCompliance>;
  medications: Array<{
    name: string;
    dose: string;
    // v1.9.0 — optional user/clinician-asserted drug-classification
    // codes. Carried here so the FHIR exporter can emit a coded
    // `medicationCodeableConcept` (ATC primary, RxNorm secondary). NULL
    // when no code was captured — the exporter then emits the pre-v1.9.0
    // text-only concept. Optional in the type so pre-v1.9.0 fixtures
    // still typecheck.
    atcCode?: string | null;
    rxNormCode?: string | null;
    schedules: Array<{
      windowStart: string;
      windowEnd: string;
      label: string | null;
    }>;
  }>;
  /**
   * v1.9.0 — acted medication-intake events over the report window, fed
   * to the FHIR `MedicationAdministration` builder. One entry per intake
   * row the user actually actioned (taken OR explicitly skipped);
   * pending / missed / soft-deleted rows are excluded upstream so the
   * exporter never asserts an administration that did not happen. The
   * `dose` is the medication's structured dose-in-effect at
   * `effectiveAt` (from `MedicationDoseChange`) when one exists, else
   * NULL. Optional so pre-v1.9.0 fixtures still typecheck.
   */
  medicationAdministrations?: Array<{
    medicationName: string;
    /** ISO timestamp: `takenAt` for a taken dose, `scheduledFor` for a skip. */
    effectiveAt: string;
    status: "completed" | "not-done";
    /** Free-text dose label (the medication's `dose`), mirrors the statement. */
    doseText: string | null;
    /** Structured dose-in-effect at `effectiveAt`, when a dose-change history exists. */
    dose: { value: number; unit: string } | null;
    /** Injection site, when the row recorded one. */
    injectionSite: string | null;
    /** ATC / RxNorm codes, mirrored from the medication for the self-describing concept. */
    atcCode: string | null;
    rxNormCode: string | null;
    /** Delivery form — ORAL / INJECTION / OTHER — for the route mapping. */
    deliveryForm: string | null;
  }>;
  /**
   * v1.9.0 — set when the administration cap (see
   * {@link resolveMaxMedicationAdministrations}) trimmed the administration
   * set. `total` is the full acted-intake count over the
   * window; `included` is how many (the most-recent) survived the cap.
   * Null/absent when nothing was trimmed. The FHIR builder discloses
   * this in the document narrative so the export is honest about the
   * omitted (oldest) rows. Optional so pre-v1.9.0 fixtures still typecheck.
   */
  medicationAdministrationsTruncation?: {
    total: number;
    included: number;
  } | null;
  mood: DoctorReportMood | null;
  /**
   * v1.4.25 W4d — GLP-1 therapy section. Populated when the user has at
   * least one active GLP-1 medication. Null/absent when the user has no
   * GLP-1 prescription (the vast majority of accounts). When set the
   * PDF gains a "GLP-1 Therapy" section listing dose history, weight
   * change over the therapy window, side-effect counts, and compliance.
   * Optional in the type so legacy callers + test fixtures that omit
   * the field continue to work; the renderer treats absent and null
   * identically.
   */
  glp1?: {
    medications: Array<{
      name: string;
      currentDose: { value: number; unit: string; since: string } | null;
      doseHistory: Array<{
        value: number;
        unit: string;
        effectiveFrom: string;
        note: string | null;
      }>;
      lastInjection: { date: string; site: string | null } | null;
      compliance: { taken: number; total: number };
    }>;
    weightDeltaKg: number | null;
    weightStartKg: number | null;
    weightEndKg: number | null;
    sideEffects: Array<{ tag: string; count: number }>;
  } | null;
  /**
   * v1.10.0 — the server-derived nightly wellness scores
   * (RECOVERY_SCORE / STRESS_SCORE / STRAIN_SCORE), summarised over the
   * report window. These are 0–100 DESCRIPTIVE composites, NOT clinical
   * vitals — they are rendered in a clearly-labelled "Wellness summary"
   * section separate from the clinical vitals table, each with a
   * "descriptive, not a clinical assessment" note. Null/absent when the
   * user has no computed scores in the window (the renderer + FHIR builder
   * then skip the section). Optional so pre-v1.10 fixtures still typecheck.
   */
  wellnessScores?: Array<{
    /** The score MeasurementType (RECOVERY_SCORE / STRESS_SCORE / STRAIN_SCORE). */
    type: string;
    latest: number;
    avg: number;
    min: number;
    max: number;
    count: number;
    /** ISO timestamp of the latest score. */
    latestAt: string;
  }> | null;
  /**
   * v1.15.0 — concise menstrual-cycle summary (LMP, recent cycles, avg
   * length + variability, current phase). Populated ONLY when the `cycle`
   * section toggle is explicitly ON (privacy default OFF — a user sharing a
   * BP report with a cardiologist must not auto-leak reproductive data) AND
   * the user has at least one observed cycle. Statistics only — no free-text
   * notes ever reach this surface. Null/absent otherwise; both the PDF and
   * FHIR builders then skip the section. Optional so pre-v1.15 fixtures
   * still typecheck.
   */
  cycle?: import("@/lib/cycle/export-data").CycleExportSummary | null;
  /**
   * v1.17.1 — structured lab results recorded over the report window.
   * Populated when the `labs` section toggle is ON (default) and the user
   * recorded at least one result in the period. Statistics + the single
   * latest reading per analyte; free-text notes never reach this surface.
   * Each entry carries the lab's reference bounds so the PDF can print an
   * in/out-of-range marker and the FHIR exporter can emit `referenceRange`.
   * Null/absent otherwise; both the PDF and FHIR builders skip the section.
   * Optional so pre-v1.17.1 fixtures still typecheck.
   */
  labResults?: Array<{
    /** Optional grouping label (e.g. "Großes Blutbild"); null = standalone. */
    panel: string | null;
    /** Biomarker name as the user recorded it. */
    analyte: string;
    /**
     * Latest numeric value for this analyte over the window; null for a
     * qualitative reading (see `valueText`). v1.18.9.
     */
    value: number | null;
    /**
     * v1.18.9 — qualitative result text ("negativ" / "positiv" / …); null for a
     * numeric reading. Exactly one of `value` / `valueText` is set.
     */
    valueText: string | null;
    unit: string;
    referenceLow: number | null;
    referenceHigh: number | null;
    /** ISO timestamp of the latest reading. */
    takenAt: string;
    /** Count of readings for this analyte in the window (≥ 1). */
    count: number;
  }> | null;
  /**
   * v1.18.1 P4 — illness / condition episodes overlapping the report window.
   * Populated ONLY when the `illness` module is enabled (default-on, opt-out);
   * the journal is on and shared deliberately, so the privacy stance matches
   * labs (ON when the module is on), not mood / cycle.
   * Statistics + labels only — the free-text note is NEVER read here, so no
   * encrypted plaintext can leak into the report. Each entry feeds a FHIR
   * `Condition` (+ `Encounter`) and a PDF table row. Null/absent when the
   * module is off or no episode overlaps the window; both builders then skip
   * the section. Optional so pre-v1.18.1 fixtures still typecheck.
   */
  illnessEpisodes?: Array<{
    /** User-facing condition label (e.g. "Erkältung"). */
    label: string;
    /** Broad condition class (INFECTION / ALLERGY / INJURY / …). */
    type: string;
    /** Lifecycle (ACUTE / CHRONIC_ONGOING / RECURRING / FLARE). */
    lifecycle: string;
    /** ISO onset instant. */
    onsetAt: string;
    /** ISO resolution instant, or null while ongoing. */
    resolvedAt: string | null;
  }> | null;
  /**
   * v1.27.x — structured allergy / intolerance records. Reference data,
   * not time-windowed: populated whenever the `allergies` section toggle
   * is ON (default) and the user recorded at least one live row. The
   * reaction description is decrypted fail-soft per row (a key-rotation
   * gap omits the value, never fails the report); the free-text note is
   * NEVER read here — same stance as the illness journal. Null/absent
   * otherwise; the PDF builder then skips the section. Optional so older
   * fixtures still typecheck.
   */
  allergies?: Array<{
    /** Substance / allergen label as the user recorded it. */
    substance: string;
    /** Category (FOOD / MEDICATION / ENVIRONMENT / BIOLOGIC / OTHER). */
    category: string;
    /** Kind (ALLERGY / INTOLERANCE). */
    type: string;
    /** Worst observed severity (NONE / MILD / MODERATE / SEVERE), or null. */
    severity: string | null;
    /** Status (ACTIVE / INACTIVE / RESOLVED). */
    status: string;
    /** Decrypted reaction description, or null (genuinely unset). */
    reaction: string | null;
    /**
     * True when a reaction description WAS stored but could not be decrypted
     * (a key-rotation gap / GCM corruption). Distinct from `reaction: null`
     * (nothing recorded) so the clinician-facing report shows an honest
     * "unreadable" marker rather than a blank that reads as "no reaction".
     */
    reactionUnreadable?: boolean;
  }> | null;
  /**
   * v1.27.x — structured family-history records. Reference data, not
   * time-windowed: populated whenever the `familyHistory` section toggle
   * is ON (default) and the user recorded at least one live row. Labels +
   * onset age only — the free-text note is never read here. Null/absent
   * otherwise; the PDF builder then skips the section. Optional so older
   * fixtures still typecheck.
   */
  familyHistory?: Array<{
    /** Relationship (MOTHER / FATHER / SISTER / …). */
    relationship: string;
    /** Condition label as the user recorded it. */
    condition: string;
    /** The relative's age at onset (years), or null when unknown. */
    ageAtOnset: number | null;
  }> | null;
}

/** The three persisted score types surfaced in the wellness summary. */
export const WELLNESS_SCORE_REPORT_TYPES = [
  "RECOVERY_SCORE",
  "STRESS_SCORE",
  "STRAIN_SCORE",
] as const;

/** One wellness-summary row (latest + range over the report window). */
interface WellnessScoreSummary {
  type: string;
  latest: number;
  avg: number;
  min: number;
  max: number;
  count: number;
  latestAt: string;
}

/** A measurement row as the doctor-report aggregator reads it (subset). */
interface RecoveryMeasurementRow {
  type: string;
  value: number;
  measuredAt: Date;
  source: MeasurementSource;
}

/** Minimal Measurement shape the canonical-source collapse consults. */
export interface CanonicalCollapseRow {
  type: string;
  value: number;
  measuredAt: Date;
  source: MeasurementSource;
  deviceType?: string | null;
}

/**
 * Collapse a window's raw Measurement rows to one canonical source per metric
 * before the doctor report computes per-type avg/min/max. Without this the PDF
 * + FHIR stats blend every source (a WHOOP + Apple-Watch resting-heart-rate
 * day would average two readings), while the dashboard / insights aggregator
 * already collapse to the ladder-canonical source per day. This routes the rows
 * through the SAME picker (`pickCanonicalSourceRows`, keyed by
 * `metricKeyForType` + the user's day key + source-priority ladder), so the two
 * surfaces report identical numbers.
 *
 * SLEEP_DURATION is passed through untouched: it carries per-stage rows that
 * `reconstructSleepNights` resolves with its own source de-dup downstream, so a
 * pre-collapse here would drop stages the night reconstruction needs. A type
 * with no ladder, or a day with a single source, passes through unchanged via
 * the picker's documented fallback. Exported for unit tests.
 */
export function collapseMeasurementsToCanonical<T extends CanonicalCollapseRow>(
  measurements: readonly T[],
  timezone: string,
  sourcePriorityJson: unknown,
): T[] {
  const dayKey = (d: Date) => userDayKey(d, timezone);
  const byType = new Map<string, T[]>();
  for (const m of measurements) {
    const slot = byType.get(m.type);
    if (slot) slot.push(m);
    else byType.set(m.type, [m]);
  }
  const out: T[] = [];
  for (const [type, rows] of byType) {
    const metricKey =
      type === "SLEEP_DURATION"
        ? null
        : metricKeyForType(type as MeasurementType);
    if (!metricKey) {
      out.push(...rows);
      continue;
    }
    const { canonicalRows } = pickCanonicalSourceRows(
      rows.map((m) => ({
        ...m,
        type: m.type as MeasurementType,
      })),
      metricKey,
      sourcePriorityJson,
      dayKey,
    );
    // `pickCanonicalSourceRows` returns the spread copies; re-key back to the
    // original rows by reference identity is unnecessary because the spread
    // preserves every field the caller reads (value / measuredAt / type).
    out.push(...(canonicalRows as unknown as T[]));
  }
  return out;
}

/**
 * Summarise RECOVERY_SCORE over the window from the CANONICAL row per day:
 * a WHOOP-native row wins over the COMPUTED proxy for the same day, so the
 * doctor PDF never blends the proxy and the native value into one min/avg/max.
 * Returns null when no recovery row exists. Exported for unit tests.
 */
export function summariseCanonicalRecovery(
  measurements: readonly RecoveryMeasurementRow[],
  timezone?: string | null,
): WellnessScoreSummary | null {
  const recovery = measurements.filter((m) => m.type === "RECOVERY_SCORE");
  if (recovery.length === 0) return null;
  const canonical = resolveCanonicalRecovery(
    recovery.map((m) => ({
      value: m.value,
      measuredAt: m.measuredAt,
      source: m.source,
    })),
    timezone,
  );
  if (canonical.length === 0) return null;
  // `resolveCanonicalRecovery` returns rows newest-first; the report wants the
  // latest value + the window range over the canonical set.
  const values = canonical.map((r) => r.value);
  const latestRow = canonical[0];
  return {
    type: "RECOVERY_SCORE",
    latest: Math.round(latestRow.value),
    avg: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
    min: Math.round(Math.min(...values)),
    max: Math.round(Math.max(...values)),
    count: values.length,
    latestAt: latestRow.measuredAt.toISOString(),
  };
}

const GLUCOSE_CONTEXTS: GlucoseContext[] = [
  "FASTING",
  "POSTPRANDIAL",
  "RANDOM",
  "BEDTIME",
];

/**
 * Validate and normalise the requested reporting window.
 * Accepts an unknown value (typically `body.days`); falls back to 90.
 */
export function normaliseDays(value: unknown, fallback = 90): number {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 365
  ) {
    return value;
  }
  return fallback;
}

const MIN_RANGE_DAYS = 1;
/**
 * Maximum span between `startDate` and `endDate`. Two years balances the
 * "give me everything I have" case (chronic condition follow-up) against
 * unbounded server work; the existing `days` fallback is capped at 365 so a
 * caller asking for a 730-day window must come through the explicit-range
 * surface and proves they want it.
 */
const MAX_RANGE_DAYS = 730;
const DEFAULT_RANGE_DAYS = 90;

/**
 * Default ceiling on the number of `MedicationAdministration` source rows
 * materialised per export, and the bounds an operator override is clamped
 * to. The report window is already bounded at {@link MAX_RANGE_DAYS}
 * (730 days), but a chronic medication dosed several times a day across
 * that window — multiplied by several such medications — can still produce
 * thousands of administration resources in a single Bundle. The default of
 * 5 000 covers ~3.5 years at four doses a day, so it effectively never bites
 * on a realistic report period while still bounding a pathological export.
 */
const DEFAULT_MAX_MEDICATION_ADMINISTRATIONS = 5000;
const MIN_MEDICATION_ADMINISTRATIONS = 1;
const MAX_MEDICATION_ADMINISTRATIONS_CEILING = 50000;

/**
 * Resolve the administration ceiling from `FHIR_MAX_MEDICATION_ADMINISTRATIONS`.
 * Accepts a positive integer within `[1, 50000]`; any unset / non-integer /
 * out-of-range value falls back to the default. Exported as a pure function so
 * the resolution can be tested without import-time env coupling.
 */
export function resolveMaxMedicationAdministrations(
  raw: string | undefined,
): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) &&
    parsed >= MIN_MEDICATION_ADMINISTRATIONS &&
    parsed <= MAX_MEDICATION_ADMINISTRATIONS_CEILING
    ? parsed
    : DEFAULT_MAX_MEDICATION_ADMINISTRATIONS;
}

export interface DoctorReportRange {
  /** Start of the reporting window (UTC, inclusive). */
  start: Date;
  /** End of the reporting window (UTC, inclusive). */
  end: Date;
  /** Inclusive day-count between `start` and `end` (rounded up). */
  days: number;
}

/** Hard cap on the printed cover line — protects PDF layout from runaway input. */
const PRACTICE_NAME_MAX_LENGTH = 120;

/**
 * Trim, collapse whitespace, drop control characters, and length-cap a
 * caller-provided practice name. Returns `null` if the result is empty so
 * the cover line is omitted entirely (rather than rendering a blank label).
 */
export function sanitisePracticeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Strip ASCII C0 + DEL controls (0x00..0x1F + 0x7F) which jsPDF can't
  // render and which break PDF text streams. Then collapse whitespace + trim.
  const cleaned = value
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, PRACTICE_NAME_MAX_LENGTH);
}

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * Turn an arbitrary `{ startDate?, endDate?, days? }` payload into a validated
 * inclusive reporting window.
 *
 * Resolution order:
 *  1. Both `startDate` AND `endDate` parse as valid ISO timestamps with
 *     `endDate >= startDate` and span <= 730 days → use them.
 *  2. Neither/invalid range, but a valid `days` integer (1..365) is provided
 *     → fall back to "last `days` days ending now".
 *  3. Otherwise fall back to "last 90 days ending now" (the v1.4.14 default).
 *
 * The function is intentionally tolerant: invalid input never throws — bad
 * shapes silently fall through to the next tier so a malformed request
 * still produces a useful report rather than a 422.
 */
export function normaliseDateRange(
  value: unknown,
  now: Date = new Date(),
): DoctorReportRange {
  const body =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const startCandidate = parseIsoDate(body.startDate);
  const endCandidate = parseIsoDate(body.endDate);

  if (startCandidate && endCandidate) {
    const startMs = startCandidate.getTime();
    const endMs = endCandidate.getTime();
    if (endMs >= startMs) {
      const spanMs = endMs - startMs;
      const spanDays = Math.ceil(spanMs / 86_400_000) || 1;
      if (spanDays >= MIN_RANGE_DAYS && spanDays <= MAX_RANGE_DAYS) {
        return {
          start: startCandidate,
          end: endCandidate,
          days: spanDays,
        };
      }
    }
  }

  const days = normaliseDays(body.days, DEFAULT_RANGE_DAYS);
  const end = now;
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  return { start, end, days };
}

export interface CollectDoctorReportOptions {
  /** Free-text practice/clinic name to print on the cover. Optional. */
  practiceName?: string | null;
  /**
   * v1.4.25 W6c — per-section visibility toggles. When omitted the
   * documented defaults apply (every section ON except mood). When
   * `sections.mood = false` the aggregator does NOT query
   * `MoodEntry` at all — the mood data never leaves the DB row
   * (privacy-by-default). Other sections are stripped from the
   * returned payload so downstream renderers (PDF + JSON consumer)
   * don't accidentally print a section the user opted out of.
   */
  sections?: Partial<DoctorReportPrefs>;
  /**
   * v1.18.0 — resolved per-user module enable/disable map. When omitted the
   * aggregator resolves it itself via `resolveModuleMap(userId)`. A disabled
   * module forces its report section / FHIR resources out of the payload,
   * regardless of the user's per-report `sections` toggles: a user who turned
   * off the Sleep module exports no sleep series, mood Observations, glucose
   * panel, recovery/strain scores, cycle summary, or lab results for the
   * modules they no longer keep. Core clinical sections (weight / BP / pulse /
   * medications) carry no module key and are always included. Injectable for
   * tests so the module ↔ section mapping can be asserted without a DB.
   */
  moduleMap?: Record<ModuleKey, boolean>;
}

/**
 * v1.17 W1a — the medication row shape the ledger compliance builder needs.
 * Carries the cadence-engine context fields (course window + creation +
 * archived schedule eras) so the same band minter the detail page uses can
 * reconstruct expected slots.
 */
export interface DoctorReportComplianceMedication {
  id: string;
  name: string;
  asNeeded: boolean;
  startsOn: Date | null;
  endsOn: Date | null;
  oneShot: boolean;
  createdAt: Date;
  schedules: ComplianceSchedule[];
  scheduleRevisions?: ScheduleRevisionLike[];
  /** v1.25 H-MED1 — pause eras so paused days drop out of the denominator. */
  pauseEras?: MedicationPauseEraLike[];
}

/** A window-bounded intake row keyed to its medication. */
export interface DoctorReportComplianceIntake extends IntakeEvent {
  medicationId: string;
}

/**
 * v1.17 W1a — doctor-report medication adherence through the dose-ledger
 * authority.
 *
 * The previous implementation tallied RAW intake rows: `taken = takenAt != null`,
 * else `skipped`, else `missed`, with the denominator being every row. That
 * double-counted cross-source duplicate rows (a REMINDER row + an API row for
 * the same slot both counted as taken), ignored band timing (a pre-window or
 * ad-hoc take counted as a plain "taken", a pending row counted as "missed"
 * regardless of the miss cutoff), and honoured no cadence (rolling / cyclic /
 * RRULE off-weeks could enter the tally). A clinician comparing the PDF % to
 * the app detail page could see two different adherence numbers for one drug.
 *
 * Route the report through the SAME ledger the detail page uses: per
 * medication, mint the cadence-aware bands over the report window
 * `[start, end]` and tally `taken` (on-time + late), `missed` and `skipped`
 * from the unified dose-history ledger. `total = taken + missed` so the
 * renderers' `taken / total` rate equals the ledger rate the detail page
 * shows. PRN / as-needed medications are excluded exactly as before (no
 * schedule, no expected dose — a fabricated 100 % on a clinical report).
 *
 * Pure / synchronous — bands come from pre-fetched schedules + intake
 * instants. Keyed by medication name to match the renderer contract.
 */
export function buildLedgerCompliance(
  medications: DoctorReportComplianceMedication[],
  intakeEvents: DoctorReportComplianceIntake[],
  userTz: string,
  start: Date,
  end: Date,
  now: Date,
): Record<string, DoctorReportCompliance> {
  const eventsByMedId = new Map<string, DoctorReportComplianceIntake[]>();
  for (const event of intakeEvents) {
    const list = eventsByMedId.get(event.medicationId);
    if (list) list.push(event);
    else eventsByMedId.set(event.medicationId, [event]);
  }

  const compliance: Record<string, DoctorReportCompliance> = {};
  for (const med of medications) {
    // PRN / as-needed carry no schedule and no expected dose — excluded so
    // the report never prints a fabricated 100 %.
    if (med.asNeeded) continue;
    if (med.schedules.length === 0) continue;

    const events = eventsByMedId.get(med.id) ?? [];
    const ctx = buildComplianceMedicationContext(
      med,
      lastNonSkippedTakenAt(events),
      userTz,
    );
    const tally = tallyComplianceFromLedger(
      events,
      med.schedules,
      ctx,
      start,
      end,
      now,
    );
    // `total = taken + missed` (the ledger denominator) so the renderer's
    // `taken / total` equals `tally.rate` — the exact number the detail page
    // shows. Deliberate skips are reported separately but stay out of `total`.
    compliance[med.name] = {
      total: tally.denominator,
      taken: tally.taken,
      skipped: tally.skipped,
      missed: tally.missed,
    };
  }
  return compliance;
}

/**
 * Decrypt an allergy reaction envelope for a clinician-facing export, keeping
 * "unreadable" distinct from "unset". A genuinely-empty envelope yields
 * `{ reaction: null, reactionUnreadable: false }`; a stored-but-undecryptable
 * one (key-rotation gap / GCM corruption) yields
 * `{ reaction: null, reactionUnreadable: true }` so the report can render an
 * honest marker instead of a blank that reads as "no reaction recorded". Pure
 * (no logging) so it is unit-testable; the caller logs on the unreadable flag.
 */
export function decryptAllergyReaction(reactionEncrypted: Uint8Array | null): {
  reaction: string | null;
  reactionUnreadable: boolean;
} {
  if (!reactionEncrypted || reactionEncrypted.byteLength === 0) {
    return { reaction: null, reactionUnreadable: false };
  }
  try {
    return {
      reaction: decryptFromBytes(reactionEncrypted),
      reactionUnreadable: false,
    };
  } catch {
    return { reaction: null, reactionUnreadable: true };
  }
}

/**
 * Aggregate the doctor-report payload for a user over a `[start, end]` range.
 * Pure data assembly — no auth, no rate-limit, no audit. Idempotent.
 *
 * `range` is validated via `normaliseDateRange()` upstream; this function
 * trusts it and uses both bounds in the Prisma `where` clause so a custom
 * window (not just "last N days") filters correctly.
 */
export async function collectDoctorReportData(
  userId: string,
  range: DoctorReportRange,
  options: CollectDoctorReportOptions = {},
): Promise<DoctorReportData> {
  const { start, end, days } = range;

  // Resolve section toggles up-front. Mood is privacy-sensitive: when
  // it's off we don't issue the `MoodEntry` findMany at all so the data
  // never lands in this process's memory. Other sections are queried
  // either way (the queries are cheap on indexed columns) and stripped
  // from the returned payload below — keeping a single source of
  // truth for the data shape regardless of toggle state.
  // v1.18.0 — resolve the per-user module map up-front (once per build). A
  // disabled module's section/resources are excluded from the export so the
  // PDF + FHIR bundle reflect only the modules the user keeps. The map is
  // ANDed over the user's per-report `sections` toggles: a disabled module
  // forces its section off even if the report toggle says on (you can't share
  // data for a module you turned off), while leaving the others untouched.
  // Core clinical sections (weight / BP / pulse / medications) have no module
  // key and stay unconditional. Injectable for tests.
  const moduleMap = options.moduleMap ?? (await resolveModuleMap(userId));

  const sections: DoctorReportPrefs = {
    ...DEFAULT_DOCTOR_REPORT_PREFS,
    ...(options.sections ?? {}),
  };
  // Module gate: a disabled module wins over the report toggle. Each report
  // section maps to its owning module key; core sections (bp/weight/pulse/
  // bmi/compliance) carry no key and are never gated here.
  if (moduleMap.mood === false) sections.mood = false;
  if (moduleMap.sleep === false) sections.sleep = false;
  if (moduleMap.cycle === false) sections.cycle = false;
  if (moduleMap.labs === false) sections.labs = false;
  // Module gates with no `sections` key — applied directly to the data slices
  // below (glucose panel, recovery/strain wellness scores, workout series).
  const glucoseEnabled = moduleMap.glucose !== false;
  const recoveryEnabled = moduleMap.recovery !== false;
  const workoutsEnabled = moduleMap.workouts !== false;

  const [measurements, medications, intakeEvents, moodEntries, userProfile] =
    await Promise.all([
      prisma.measurement.findMany({
        // v1.4.41 W-DELETED-2 — exclude soft-deleted measurements from
        // the doctor-report aggregator so deleted rows never leak into
        // the JSON payload or the server-rendered PDF.
        where: {
          userId,
          measuredAt: { gte: start, lte: end },
          deletedAt: null,
        },
        orderBy: { measuredAt: "asc" },
      }),
      prisma.medication.findMany({
        where: { userId, active: true },
        include: {
          // v1.15.20 — the shared compliance select (plus `label`, which the
          // FHIR schedule mapping below needs) so a future engine column added
          // to SCHEDULE_COMPLIANCE_SELECT reaches the doctor-report surface.
          schedules: { select: { ...SCHEDULE_COMPLIANCE_SELECT, label: true } },
          // v1.17 W1a — archived schedule eras so the ledger compliance
          // builder segments expected-slot expansion against the schedule
          // that was live on each past day (matches the detail page).
          scheduleRevisions: {
            orderBy: { validFrom: "asc" },
            select: {
              id: true,
              validFrom: true,
              validUntil: true,
              payload: true,
              supersededByRevisionId: true,
            },
          },
          // v1.25 H-MED1 — pause eras so paused days drop out of the denominator.
          pauseEras: { select: { pausedAt: true, resumedAt: true } },
          // v1.4.25 W4d — eager-load dose history + recent intake site
          // for any active medication. Generic meds carry empty arrays
          // so the legacy data path is byte-identical.
          doseChanges: { orderBy: { effectiveFrom: "asc" } },
          intakeEvents: {
            where: { takenAt: { not: null } },
            orderBy: { takenAt: "desc" },
            take: 1,
            select: { takenAt: true, injectionSite: true },
          },
        },
      }),
      prisma.medicationIntakeEvent.findMany({
        // v1.7.0 sync — exclude tombstoned rows from the doctor report.
        where: {
          userId,
          deletedAt: null,
          scheduledFor: { gte: start, lte: end },
        },
        include: {
          // v1.9.0 — carry the medication identity + codes + delivery
          // form so the FHIR MedicationAdministration builder can emit a
          // self-describing `medicationCodeableConcept` and a route.
          medication: {
            select: {
              id: true,
              name: true,
              dose: true,
              atcCode: true,
              rxNormCode: true,
              deliveryForm: true,
              asNeeded: true,
            },
          },
        },
        orderBy: { scheduledFor: "asc" },
      }),
      // Mood data: zero DB read when the user opted out. This is the
      // privacy-by-default contract — the JSON payload + audit log
      // both reflect "mood was never fetched", not "mood was fetched
      // and then dropped".
      sections.mood
        ? prisma.moodEntry.findMany({
            // v1.7.0 sync — exclude tombstoned rows from the doctor report.
            where: {
              userId,
              deletedAt: null,
              moodLoggedAt: { gte: start, lte: end },
            },
            orderBy: { moodLoggedAt: "asc" },
          })
        : Promise.resolve([]),
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          username: true,
          dateOfBirth: true,
          gender: true,
          heightCm: true,
          glucoseUnit: true,
          thresholdsJson: true,
          // v1.17 W1a — the user timezone anchors the ledger compliance
          // band minter (matches the detail page's dose-day attribution).
          timezone: true,
          // v1.17.1 — source-priority feeds the per-night sleep reconstruction
          // so the report's SLEEP_DURATION resolves the same canonical night
          // (multi-source de-dup) the dashboard + iOS feed show.
          sourcePriorityJson: true,
          // v1.7.0 — patient-identity fields for the export cover + FHIR
          // Patient. KVNR is encrypted (and not selected here) — the route
          // decrypts it and hands it to the builders.
          fullName: true,
          insurerName: true,
          insurerIkNumber: true,
        },
      }),
    ]);

  const reportTz = userProfile?.timezone ?? "Europe/Berlin";

  // v1.18.0 — collapse each multi-source metric to its CANONICAL source before
  // grouping, so the report's per-type avg/min/max match the dashboard rather
  // than blending overlapping sources (e.g. WHOOP + Apple Watch resting-heart-
  // rate summed into one inflated mean). See `collapseMeasurementsToCanonical`.
  const canonicalMeasurements = collapseMeasurementsToCanonical(
    measurements,
    reportTz,
    userProfile?.sourcePriorityJson ?? null,
  );

  // Group measurements by type (canonical-source-collapsed).
  const byType: Record<
    string,
    Array<{ value: number; measuredAt: string }>
  > = {};
  for (const m of canonicalMeasurements) {
    if (!byType[m.type]) byType[m.type] = [];
    byType[m.type].push({
      value: m.value,
      measuredAt: m.measuredAt.toISOString(),
    });
  }
  // measuredAt-ascending within each type so `latest` (last element) is the
  // most recent reading after the canonical collapse reorders by bucket.
  for (const entries of Object.values(byType)) {
    entries.sort((a, b) => a.measuredAt.localeCompare(b.measuredAt));
  }

  // v1.17.1 parity — SLEEP_DURATION enters `byType` as RAW per-stage rows (a
  // 40-min DEEP block, a 12-min AWAKE block, …). Every other sleep surface
  // (dashboard slim slice, /insights/sleep, /api/sleep/night, the iOS feed)
  // shows the per-night reconstructed asleep total via `summarizeSleepNights`,
  // and the v1.17.1 stamping fixes rewrite exactly those raw stage rows. Route
  // the report's sleep value through the same engine — one number, one surface
  // — exactly as RECOVERY_SCORE routes through `summariseCanonicalRecovery`.
  const sleepRows = measurements.filter(
    (m) => m.type === "SLEEP_DURATION",
  ) as unknown as SleepStageRow[];
  if (sleepRows.length > 0) {
    const nights = reconstructSleepNights(
      sleepRows,
      reportTz,
      userProfile?.sourcePriorityJson ?? null,
    ).filter((n) => n.asleepMinutes > 0);
    // Per-night asleep totals, ascending by night, replace the raw per-stage
    // rows so the clinical vitals table reads time-asleep hours, not stage-row
    // minutes. Empty (no scorable night) drops SLEEP_DURATION entirely.
    if (nights.length > 0) {
      byType.SLEEP_DURATION = nights.map((n) => ({
        value: n.asleepMinutes,
        measuredAt: n.measuredAt.toISOString(),
      }));
    } else {
      delete byType.SLEEP_DURATION;
    }
  }

  // Per-type stats.
  const stats: Record<string, DoctorReportStats> = {};
  for (const [type, entries] of Object.entries(byType)) {
    const values = entries.map((e) => e.value);
    stats[type] = {
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      count: values.length,
      latest: values[values.length - 1],
    };
  }

  // v1.17 W1a — medication compliance through the dose-ledger authority (the
  // same engine the detail page uses), NOT a raw-row tally. Routes each
  // scheduled medication's intake rows through the cadence-aware band minter
  // over the report window so the PDF / FHIR adherence % matches the app's
  // detail page (slot dedup, band timing, cadence honoured). As-needed / PRN
  // medications are excluded — no schedule, no expected dose, no fabricated
  // 100 % on a clinical report. The medication itself stays on the list.
  const compliance = buildLedgerCompliance(
    medications.map((m) => ({
      id: m.id,
      name: m.name,
      asNeeded: m.asNeeded,
      startsOn: m.startsOn,
      endsOn: m.endsOn,
      oneShot: m.oneShot,
      createdAt: m.createdAt,
      schedules: m.schedules,
      scheduleRevisions: m.scheduleRevisions,
      pauseEras: m.pauseEras,
    })),
    intakeEvents.map((e) => ({
      medicationId: e.medicationId,
      scheduledFor: e.scheduledFor,
      takenAt: e.takenAt,
      skipped: e.skipped,
      autoMissed: e.autoMissed ?? false,
      attributionSource: e.attributionSource ?? undefined,
    })),
    reportTz,
    start,
    end,
    end,
  );

  // v1.9.0 — MedicationAdministration source rows. One entry per acted
  // intake (taken OR explicitly skipped); pending / missed rows are
  // dropped so the FHIR export never asserts an administration that did
  // not happen, and tombstoned rows are already excluded by the query
  // `deletedAt: null` predicate. The structured `dose` is resolved from
  // the medication's `MedicationDoseChange` history — the latest change
  // effective at or before the administration instant — when one exists.
  //
  // Dose-change history is loaded on the `medications` array (active
  // meds only); a per-medicationId index lets the resolver run in O(1)
  // lookups + a short linear scan over the (typically small) change list.
  const doseChangesByMedId = new Map<
    string,
    Array<{ effectiveFrom: Date; doseValue: number; doseUnit: string }>
  >();
  for (const m of medications) {
    doseChangesByMedId.set(
      m.id,
      m.doseChanges.map((dc) => ({
        effectiveFrom: dc.effectiveFrom,
        doseValue: dc.doseValue,
        doseUnit: dc.doseUnit,
      })),
    );
  }
  const resolveDoseInEffect = (
    medicationId: string,
    at: Date,
  ): { value: number; unit: string } | null => {
    const changes = doseChangesByMedId.get(medicationId);
    if (!changes || changes.length === 0) return null;
    // `doseChanges` are loaded ordered by `effectiveFrom asc`; take the
    // last one whose effectiveFrom is <= the administration instant.
    let inEffect: { value: number; unit: string } | null = null;
    for (const c of changes) {
      if (c.effectiveFrom.getTime() <= at.getTime()) {
        inEffect = { value: c.doseValue, unit: c.doseUnit };
      } else {
        break;
      }
    }
    return inEffect;
  };

  const medicationAdministrations: NonNullable<
    DoctorReportData["medicationAdministrations"]
  > = [];
  for (const event of intakeEvents) {
    // Only acted rows: a taken dose (completed) or an explicit skip
    // (not-done). A scheduled-but-unconfirmed ("missed") slot is not an
    // administration event and is omitted entirely.
    const isTaken = event.takenAt !== null;
    if (!isTaken && !event.skipped) continue;
    const effectiveAt = isTaken ? (event.takenAt as Date) : event.scheduledFor;
    medicationAdministrations.push({
      medicationName: event.medication.name,
      effectiveAt: effectiveAt.toISOString(),
      status: isTaken ? "completed" : "not-done",
      doseText: event.medication.dose || null,
      // Structured dose only meaningful for a taken dose with a
      // dose-change history; a skip records no dose consumed.
      dose: isTaken
        ? resolveDoseInEffect(event.medication.id, effectiveAt)
        : null,
      injectionSite: event.injectionSite ?? null,
      atcCode: event.medication.atcCode ?? null,
      rxNormCode: event.medication.rxNormCode ?? null,
      deliveryForm: event.medication.deliveryForm ?? null,
    });
  }

  // v1.9.0 — bound the administration set. `intakeEvents` is ordered
  // `scheduledFor: asc`, so the most-recent acted rows are at the tail;
  // keep the last N and flag the trim so the FHIR narrative can disclose
  // it. The omitted rows are the OLDEST in the window — recent adherence
  // is preserved intact. The cap is a coarse safety ceiling (the report
  // window is the natural bound; this only guards a pathological
  // multi-year, many-medication export) — resolved per call from
  // `FHIR_MAX_MEDICATION_ADMINISTRATIONS` so an operator override takes
  // effect without a code change.
  const maxMedicationAdministrations = resolveMaxMedicationAdministrations(
    process.env.FHIR_MAX_MEDICATION_ADMINISTRATIONS,
  );
  const totalAdministrations = medicationAdministrations.length;
  const medicationAdministrationsTruncated =
    totalAdministrations > maxMedicationAdministrations;
  const cappedAdministrations = medicationAdministrationsTruncated
    ? medicationAdministrations.slice(
        totalAdministrations - maxMedicationAdministrations,
      )
    : medicationAdministrations;

  // Mood summary.
  const moodScores = moodEntries.map((e) => e.score);
  const mood: DoctorReportMood | null =
    moodScores.length > 0
      ? {
          avg: moodScores.reduce((a, b) => a + b, 0) / moodScores.length,
          min: Math.min(...moodScores),
          max: Math.max(...moodScores),
          count: moodScores.length,
          distribution: {
            1: moodScores.filter((s) => s === 1).length,
            2: moodScores.filter((s) => s === 2).length,
            3: moodScores.filter((s) => s === 3).length,
            4: moodScores.filter((s) => s === 4).length,
            5: moodScores.filter((s) => s === 5).length,
          },
        }
      : null;

  // BMI from latest weight + profile height.
  const weightStats = stats.WEIGHT;
  const bmiRaw =
    weightStats && userProfile?.heightCm
      ? weightStats.latest / (userProfile.heightCm / 100) ** 2
      : null;
  const bmi = bmiRaw !== null ? Math.round(bmiRaw * 10) / 10 : null;

  // Per-context glucose stats + effective ranges (canonical mg/dL).
  const glucoseStats: Record<string, DoctorReportStats> = {};
  const glucoseRanges: Record<string, { min: number; max: number }> = {};
  // v1.18.0 — when the glucose module is disabled, no glucose row enters the
  // panel: stats, ranges, and the clinical metrics all collapse to empty so the
  // PDF + FHIR Observations carry no glucose for this user.
  const glucoseRows = glucoseEnabled
    ? measurements.filter((m) => m.type === "BLOOD_GLUCOSE")
    : [];
  const overrides = (userProfile?.thresholdsJson ??
    null) as ThresholdOverridesJson | null;
  const profileForRange = {
    heightCm: userProfile?.heightCm ?? null,
    dateOfBirth: userProfile?.dateOfBirth ?? null,
    gender: userProfile?.gender ?? null,
  };
  for (const ctx of GLUCOSE_CONTEXTS) {
    const rows = glucoseRows.filter((m) => m.glucoseContext === ctx);
    if (rows.length === 0) continue;
    const values = rows.map((r) => r.value);
    glucoseStats[ctx] = {
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      count: values.length,
      latest: values[values.length - 1],
    };
    const eff = getEffectiveRange(
      thresholdMetricForContext(ctx),
      profileForRange,
      overrides,
    );
    if (eff.range) {
      glucoseRanges[ctx] = { min: eff.range.greenMin, max: eff.range.greenMax };
    }
  }

  // v1.17.0 — clinical panel over the WHOLE report period (all contexts
  // pooled), computed by the one literature-locked engine the insights panel
  // and the coach also consume. `windowDays` is the report's own period so the
  // TIR / GMI / eA1C / CV% reflect exactly the readings the rest of the report
  // tabulates; `now: end` anchors the window to the report's upper bound. The
  // learning gate keeps a thin period from asserting a clinical AGP off spot
  // data. Values stay canonical mg/dL; the renderer converts with `glucoseUnit`.
  const glucoseClinical = computeGlucoseClinicalMetrics(
    glucoseRows.map((r) => ({ measuredAt: r.measuredAt, mgdl: r.value })),
    { windowDays: days, now: end },
  );

  // `practiceName` is sanitised to a single-line string with a hard length
  // cap. The PDF cover prints it verbatim — never let unbounded input land in
  // a layout-sensitive header.
  const practiceName = sanitisePracticeName(options.practiceName);

  // Apply section toggles. Removing the type's keys from `byType`,
  // `stats`, and `compliance` lets the PDF renderer treat "section
  // disabled" identically to "section had no rows" — both paths skip
  // the table. Mood is already null when disabled (we never queried).
  const filteredByType = filterMeasurementKeys(byType, sections, moduleMap);
  const filteredStats = filterMeasurementKeys(stats, sections, moduleMap);
  const filteredCompliance = sections.compliance ? compliance : {};
  const filteredBmi = sections.bmi ? bmi : null;

  // v1.4.25 W4d — GLP-1 therapy section. Only assembled when the user
  // has at least one active GLP-1 medication AND the compliance toggle
  // is on (per the privacy contract: a doctor-report dose history needs
  // the compliance section enabled to be useful). Generic accounts
  // get `glp1: null` which the PDF renderer skips entirely.
  const glp1Meds = medications.filter((m) => m.treatmentClass === "GLP1");
  let glp1: DoctorReportData["glp1"] = null;
  if (sections.compliance && glp1Meds.length > 0) {
    const weightSorted = (byType.WEIGHT ?? []).slice();
    const weightStartKg = weightSorted[0]?.value ?? null;
    const weightEndKg = weightSorted[weightSorted.length - 1]?.value ?? null;
    const weightDeltaKg =
      weightStartKg !== null && weightEndKg !== null
        ? Math.round((weightEndKg - weightStartKg) * 10) / 10
        : null;

    // Side-effect tag counts (only when mood section is enabled — we
    // already gated the moodEntries read on `sections.mood`, so this
    // collapses to "no tags" when the user opted out).
    const sideEffectTags = new Set([
      "nausea",
      "constipation",
      "diarrhea",
      "fatigue",
      "appetite-loss",
      "heartburn",
      "headache",
      "übelkeit",
      "verstopfung",
      "durchfall",
      "müdigkeit",
      "appetitlosigkeit",
      "sodbrennen",
      "kopfschmerzen",
    ]);
    const sideEffectCounts = new Map<string, number>();
    for (const mood of moodEntries) {
      const rawTags = mood.tags ?? "";
      let tags: string[];
      try {
        const parsed = JSON.parse(rawTags);
        tags = Array.isArray(parsed)
          ? parsed
              .map((v: unknown) => (typeof v === "string" ? v.trim() : ""))
              .filter(Boolean)
          : [];
      } catch {
        tags = rawTags
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
      }
      for (const tag of tags) {
        const lower = tag.toLowerCase();
        if (!sideEffectTags.has(lower)) continue;
        sideEffectCounts.set(lower, (sideEffectCounts.get(lower) ?? 0) + 1);
      }
    }

    glp1 = {
      medications: glp1Meds.map((m) => {
        const latest = m.doseChanges[m.doseChanges.length - 1] ?? null;
        const lastIntake = m.intakeEvents[0] ?? null;
        const comp = compliance[m.name] ?? {
          taken: 0,
          total: 0,
          skipped: 0,
          missed: 0,
        };
        return {
          name: m.name,
          currentDose: latest
            ? {
                value: latest.doseValue,
                unit: latest.doseUnit,
                since: latest.effectiveFrom.toISOString(),
              }
            : null,
          doseHistory: m.doseChanges.map((dc) => ({
            value: dc.doseValue,
            unit: dc.doseUnit,
            effectiveFrom: dc.effectiveFrom.toISOString(),
            note: readNote(dc.noteEncrypted, dc.note),
          })),
          lastInjection:
            lastIntake && lastIntake.takenAt
              ? {
                  date: lastIntake.takenAt.toISOString(),
                  site: lastIntake.injectionSite,
                }
              : null,
          compliance: { taken: comp.taken, total: comp.total },
        };
      }),
      weightStartKg,
      weightEndKg,
      weightDeltaKg,
      sideEffects: Array.from(sideEffectCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([tag, count]) => ({ tag, count })),
    };
  }

  // v1.10.0 — wellness-score summary. The persisted `*_SCORE` rows are already
  // in `byType`/`stats` (they're only filtered out of the clinical vitals
  // table). Summarise each present score type for the separate "Wellness
  // summary" section. Empty array → null so the renderer + FHIR builder skip
  // the section entirely.
  //
  // RECOVERY_SCORE carries BOTH the WHOOP-native row and the COMPUTED proxy for
  // the same day; mixing them into one min/avg/max would blend two distinct
  // series. Resolve to the canonical row per day (WHOOP wins) so the PDF reads
  // the SAME value the tile + iOS feed show — one number, one engine.
  const wellnessScoreSummaries = WELLNESS_SCORE_REPORT_TYPES.flatMap((type) => {
    // v1.18.0 — module gate per score type. Recovery + stress are the
    // recovery/readiness signals (recovery module); strain is the
    // training-load signal derived from the workouts table (workouts module).
    // A disabled owning module drops the score from the wellness summary and,
    // since the FHIR exporter sources these Observations from
    // `data.wellnessScores`, from the bundle too.
    if (type === "STRAIN_SCORE" && !workoutsEnabled) return [];
    if (
      (type === "RECOVERY_SCORE" || type === "STRESS_SCORE") &&
      !recoveryEnabled
    ) {
      return [];
    }
    if (type === "RECOVERY_SCORE") {
      const summary = summariseCanonicalRecovery(measurements, reportTz);
      return summary ? [summary] : [];
    }
    const s = stats[type];
    const rows = byType[type];
    if (!s || !rows || rows.length === 0) return [];
    return [
      {
        type,
        latest: Math.round(s.latest),
        avg: Math.round(s.avg),
        min: Math.round(s.min),
        max: Math.round(s.max),
        count: s.count,
        latestAt: rows[rows.length - 1].measuredAt,
      },
    ];
  });
  const wellnessScores =
    wellnessScoreSummaries.length > 0 ? wellnessScoreSummaries : null;

  // v1.15.0 — cycle summary. Privacy default OFF: only read + assemble when
  // the `cycle` section toggle is explicitly ON. Statistics only — the
  // helper never touches `notesEncrypted`, so no plaintext free-text can
  // leak through this surface. `null` when disabled or no observed cycle.
  let cycle: DoctorReportData["cycle"] = null;
  if (sections.cycle) {
    cycle = await buildCycleExportSummary(
      userId,
      end.toISOString().slice(0, 10),
    );
  }

  // v1.17.1 — structured lab results over the window. ON by default; the
  // user recorded these specifically to share with a clinician, so the
  // privacy stance matches BP / weight, not mood / cycle. We reduce to the
  // latest reading per analyte (with a count) so the report is a concise
  // panel, not a raw dump; notes are never read here.
  let labResults: DoctorReportData["labResults"] = null;
  if (sections.labs) {
    const labRows = await prisma.labResult.findMany({
      where: { userId, takenAt: { gte: start, lte: end }, deletedAt: null },
      orderBy: { takenAt: "asc" },
      select: {
        panel: true,
        analyte: true,
        value: true,
        valueText: true,
        unit: true,
        referenceLow: true,
        referenceHigh: true,
        takenAt: true,
      },
    });
    // Latest-per-analyte, keyed case-insensitively so "LDL" / "ldl" fold
    // together; rows are ascending so the last seen wins as the latest.
    const byAnalyte = new Map<
      string,
      NonNullable<DoctorReportData["labResults"]>[number]
    >();
    for (const r of labRows) {
      const key = r.analyte.toLowerCase();
      const prev = byAnalyte.get(key);
      byAnalyte.set(key, {
        panel: r.panel,
        analyte: r.analyte,
        value: r.value,
        valueText: r.valueText,
        unit: r.unit,
        referenceLow: r.referenceLow,
        referenceHigh: r.referenceHigh,
        takenAt: r.takenAt.toISOString(),
        count: (prev?.count ?? 0) + 1,
      });
    }
    const collapsed = Array.from(byAnalyte.values());
    labResults = collapsed.length > 0 ? collapsed : null;
  }

  // v1.18.1 P4 — illness / condition episodes overlapping the window. Gated
  // on the illness module (default-on, opt-out): when off, no read, no section.
  // An episode overlaps when it began on or before the window end AND is
  // either still ongoing or resolved on or after the window start. Labels +
  // lifecycle + dates only — the encrypted note is never selected, so no
  // free-text leaks into the clinical export.
  let illnessEpisodes: DoctorReportData["illnessEpisodes"] = null;
  if (moduleMap.illness !== false) {
    const episodeRows = await prisma.illnessEpisode.findMany({
      where: {
        userId,
        deletedAt: null,
        onsetAt: { lte: end },
        OR: [{ resolvedAt: null }, { resolvedAt: { gte: start } }],
      },
      orderBy: { onsetAt: "asc" },
      select: {
        label: true,
        type: true,
        lifecycle: true,
        onsetAt: true,
        resolvedAt: true,
      },
    });
    const mapped = episodeRows.map((e) => ({
      label: e.label,
      type: e.type,
      lifecycle: e.lifecycle,
      onsetAt: e.onsetAt.toISOString(),
      resolvedAt: e.resolvedAt ? e.resolvedAt.toISOString() : null,
    }));
    illnessEpisodes = mapped.length > 0 ? mapped : null;
  }

  // v1.27.x — structured allergies + family history. Reference data, not
  // time-windowed (a penicillin allergy does not expire with the report
  // window), so no date filter. Riding the section toggles keeps the "you
  // can deselect any section" contract; both default ON — a clinical
  // report without an allergy section is the riskier default. The
  // reaction description decrypts fail-soft per row; the free-text notes
  // are never selected, matching the illness-journal stance.
  let allergies: DoctorReportData["allergies"] = null;
  if (sections.allergies) {
    const rows = await prisma.allergy.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        substance: true,
        category: true,
        type: true,
        severity: true,
        status: true,
        reactionEncrypted: true,
      },
    });
    const mapped = rows.map((r) => {
      const { reaction, reactionUnreadable } = decryptAllergyReaction(
        r.reactionEncrypted,
      );
      if (reactionUnreadable) {
        // A reaction WAS recorded but is undecryptable (key gap / GCM
        // corruption). It is flagged (not silently blanked) so the PDF renders
        // an honest "unreadable" marker; log the swallowed decrypt so a
        // systemic key-config failure is visible rather than masquerading as
        // "no reaction recorded" on a clinician-facing export.
        getEvent()?.addWarning(
          `doctor-report: allergy reaction decrypt failed for ${userId} (substance=${r.substance})`,
        );
      }
      return {
        substance: r.substance,
        category: r.category,
        type: r.type,
        severity: r.severity,
        status: r.status,
        reaction,
        reactionUnreadable,
      };
    });
    allergies = mapped.length > 0 ? mapped : null;
  }

  let familyHistory: DoctorReportData["familyHistory"] = null;
  if (sections.familyHistory) {
    const rows = await prisma.familyHistoryEntry.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { relationship: true, condition: true, ageAtOnset: true },
    });
    familyHistory = rows.length > 0 ? rows : null;
  }

  return {
    period: {
      days,
      // `since` is preserved for backwards compatibility with any in-flight
      // clients that read the old field name; mirrors `start`.
      since: start.toISOString(),
      start: start.toISOString(),
      end: end.toISOString(),
    },
    patient: {
      username: userProfile?.username ?? null,
      dateOfBirth: userProfile?.dateOfBirth
        ? userProfile.dateOfBirth.toISOString()
        : null,
      gender: userProfile?.gender ?? null,
      heightCm: userProfile?.heightCm ?? null,
      fullName: userProfile?.fullName ?? null,
      insurerName: userProfile?.insurerName ?? null,
      insurerIkNumber: userProfile?.insurerIkNumber ?? null,
    },
    practiceName,
    measurements: filteredByType,
    stats: filteredStats,
    glucoseStats,
    glucoseRanges,
    // Surfaced by the insights glucose views; the doctor-PDF / FHIR rendering of
    // these clinical metrics is staged for a later release, so no report
    // consumer reads this field yet — it is forward-populated, not dead.
    glucoseClinical,
    glucoseUnit: resolveGlucoseUnit(userProfile?.glucoseUnit ?? null),
    bmi: filteredBmi,
    compliance: filteredCompliance,
    medications: medications.map((m) => ({
      name: m.name,
      dose: m.dose,
      // v1.9.0 — drug-classification codes for the coded FHIR concept.
      atcCode: m.atcCode,
      rxNormCode: m.rxNormCode,
      schedules: m.schedules.map((s) => ({
        windowStart: s.windowStart,
        windowEnd: s.windowEnd,
        label: s.label,
      })),
    })),
    medicationAdministrations: cappedAdministrations,
    medicationAdministrationsTruncation: medicationAdministrationsTruncated
      ? { total: totalAdministrations, included: cappedAdministrations.length }
      : null,
    mood,
    glp1,
    wellnessScores,
    cycle,
    labResults,
    illnessEpisodes,
    allergies,
    familyHistory,
  };
}

/**
 * Per-measurement-type → section-toggle mapping. Keys not listed here
 * (e.g., glucose contexts, body fat, oxygen saturation) bypass the
 * toggles for now — those sections will get their own flags in a
 * future iteration. The current scope per the maintainer's directive is the
 * "big five" plus mood + compliance.
 */
const MEASUREMENT_TYPE_SECTION: Record<string, keyof DoctorReportPrefs> = {
  BLOOD_PRESSURE_SYS: "bp",
  BLOOD_PRESSURE_DIA: "bp",
  WEIGHT: "weight",
  PULSE: "pulse",
  SLEEP_DURATION: "sleep",
};

/**
 * v1.18.0 — per-measurement-type → owning module mapping for the types that
 * carry no `sections` toggle but DO belong to a toggleable module. When the
 * module is disabled, the type is stripped from `measurements` + `stats` so the
 * series never reaches the PDF tables or a FHIR Observation.
 *
 *   - `workouts` owns the activity / movement series (steps, active energy,
 *     distance, flights, the walking-gait + stair metrics) and the
 *     training-load `STRAIN_SCORE`.
 *   - `recovery` owns the readiness signals `RECOVERY_SCORE` + `STRESS_SCORE`.
 *   - `glucose` owns the raw `BLOOD_GLUCOSE` series (the glucose panel itself is
 *     gated where it is assembled; this strips the raw rows too).
 *
 * Core clinical types (BP / weight / pulse / body-composition / vitals) carry
 * no module and are never gated here. `sleep` / `mood` / `cycle` / `labs` ride
 * the `sections` mechanism instead.
 */
const MEASUREMENT_TYPE_MODULE: Record<string, ModuleKey> = {
  ACTIVITY_STEPS: "workouts",
  ACTIVE_ENERGY_BURNED: "workouts",
  FLIGHTS_CLIMBED: "workouts",
  WALKING_RUNNING_DISTANCE: "workouts",
  WALKING_SPEED: "workouts",
  WALKING_ASYMMETRY: "workouts",
  WALKING_STEP_LENGTH: "workouts",
  WALKING_DOUBLE_SUPPORT: "workouts",
  SIX_MINUTE_WALK_DISTANCE: "workouts",
  STAIR_ASCENT_SPEED: "workouts",
  STAIR_DESCENT_SPEED: "workouts",
  STRAIN_SCORE: "workouts",
  RECOVERY_SCORE: "recovery",
  STRESS_SCORE: "recovery",
  BLOOD_GLUCOSE: "glucose",
  // v1.25.0 — the PHQ-9 / GAD-7 screener TOTALS ride the doctor-report / FHIR
  // export only when the opt-in mental-health module is on (default OFF →
  // excluded by default, privacy-by-default). Item-level answers are never a
  // Measurement, so they can never leak through this path regardless. The total
  // is the intended clinical artefact (total + band per clinical-instruments.md
  // §4); gating it on the module keeps the export consistent with how mood /
  // sleep / glucose are gated and avoids exporting a screener the account never
  // opted into.
  PHQ9_SCORE: "mentalHealth",
  GAD7_SCORE: "mentalHealth",
  // v1.27.9 — the WHO-5 / SCI totals ride the same module gate.
  WHO5_SCORE: "mentalHealth",
  SCI_SCORE: "mentalHealth",
};

function filterMeasurementKeys<T>(
  map: Record<string, T>,
  sections: DoctorReportPrefs,
  moduleMap: Record<ModuleKey, boolean>,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [type, value] of Object.entries(map)) {
    const sectionKey = MEASUREMENT_TYPE_SECTION[type];
    if (sectionKey && sections[sectionKey] === false) continue;
    const moduleKey = MEASUREMENT_TYPE_MODULE[type];
    if (moduleKey && moduleMap[moduleKey] === false) continue;
    out[type] = value;
  }
  return out;
}
