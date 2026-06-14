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
import type { GlucoseContext } from "@/generated/prisma/client";
import {
  DEFAULT_DOCTOR_REPORT_PREFS,
  type DoctorReportPrefs,
} from "@/lib/validations/doctor-report-prefs";
import { buildCycleExportSummary } from "@/lib/cycle/export-data";
import {
  buildComplianceMedicationContext,
  lastNonSkippedTakenAt,
  tallyComplianceFromLedger,
  type ComplianceSchedule,
  type IntakeEvent,
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
}

/** The three persisted score types surfaced in the wellness summary. */
export const WELLNESS_SCORE_REPORT_TYPES = [
  "RECOVERY_SCORE",
  "STRESS_SCORE",
  "STRAIN_SCORE",
] as const;

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
  const cleaned = value.replace(/[\x00-\x1F\x7F]/g, " ").replace(/\s+/g, " ").trim();
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
  const sections: DoctorReportPrefs = {
    ...DEFAULT_DOCTOR_REPORT_PREFS,
    ...(options.sections ?? {}),
  };

  const [measurements, medications, intakeEvents, moodEntries, userProfile] =
    await Promise.all([
      prisma.measurement.findMany({
        // v1.4.41 W-DELETED-2 — exclude soft-deleted measurements from
        // the doctor-report aggregator so deleted rows never leak into
        // the JSON payload or the server-rendered PDF.
        where: { userId, measuredAt: { gte: start, lte: end }, deletedAt: null },
        orderBy: { measuredAt: "asc" },
      }),
      prisma.medication.findMany({
        where: { userId, active: true },
        include: {
          schedules: true,
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
        where: { userId, deletedAt: null, scheduledFor: { gte: start, lte: end } },
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
            where: { userId, deletedAt: null, moodLoggedAt: { gte: start, lte: end } },
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
          // v1.7.0 — patient-identity fields for the export cover + FHIR
          // Patient. KVNR is encrypted (and not selected here) — the route
          // decrypts it and hands it to the builders.
          fullName: true,
          insurerName: true,
          insurerIkNumber: true,
        },
      }),
    ]);

  // Group measurements by type.
  const byType: Record<
    string,
    Array<{ value: number; measuredAt: string }>
  > = {};
  for (const m of measurements) {
    if (!byType[m.type]) byType[m.type] = [];
    byType[m.type].push({
      value: m.value,
      measuredAt: m.measuredAt.toISOString(),
    });
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
  const reportTz = userProfile?.timezone ?? "Europe/Berlin";
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
    const effectiveAt = isTaken
      ? (event.takenAt as Date)
      : event.scheduledFor;
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
  const glucoseRows = measurements.filter((m) => m.type === "BLOOD_GLUCOSE");
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

  // `practiceName` is sanitised to a single-line string with a hard length
  // cap. The PDF cover prints it verbatim — never let unbounded input land in
  // a layout-sensitive header.
  const practiceName = sanitisePracticeName(options.practiceName);

  // Apply section toggles. Removing the type's keys from `byType`,
  // `stats`, and `compliance` lets the PDF renderer treat "section
  // disabled" identically to "section had no rows" — both paths skip
  // the table. Mood is already null when disabled (we never queried).
  const filteredByType = filterMeasurementKeys(byType, sections);
  const filteredStats = filterMeasurementKeys(stats, sections);
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
            note: dc.note,
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

  // v1.10.0 — wellness-score summary. The persisted COMPUTED `*_SCORE`
  // rows are already in `byType`/`stats` (they're only filtered out of the
  // clinical vitals table). Summarise each present score type for the
  // separate "Wellness summary" section. Empty array → null so the renderer
  // + FHIR builder skip the section entirely.
  const wellnessScoreSummaries = WELLNESS_SCORE_REPORT_TYPES.flatMap((type) => {
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

function filterMeasurementKeys<T>(
  map: Record<string, T>,
  sections: DoctorReportPrefs,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [type, value] of Object.entries(map)) {
    const sectionKey = MEASUREMENT_TYPE_SECTION[type];
    if (sectionKey && sections[sectionKey] === false) continue;
    out[type] = value;
  }
  return out;
}
