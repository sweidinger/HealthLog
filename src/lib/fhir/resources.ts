/**
 * v1.11.0 — shared per-resource FHIR R4 emitters.
 *
 * The Observation / MedicationStatement / MedicationAdministration / Patient /
 * Coverage builders (with their LOINC/ATC/SNOMED/UCUM codings + the `survey`
 * wellness split) live here as small pure functions over the SAME
 * `DoctorReportData` the document-bundle builder consumes.
 *
 * Two callers share these emitters: `buildFhirDocumentBundle` composes them
 * into a `type: "document"` Bundle, and the FHIR REST search routes wrap them
 * in a `type: "searchset"` Bundle. Keeping the coding logic in one place means
 * the LOINC/UCUM/ATC mapping has exactly one home — the document export and
 * the REST face can never drift apart.
 *
 * No FHIR SDK, no `@types/fhir` — narrow hand-rolled interfaces only
 * (`./types`), matching the project's "hand-rolled over the documented wire"
 * convention. All text is escaped plain text; never user-supplied HTML
 * (no markdown library, no `dangerouslySetInnerHTML`).
 */
import type { DoctorReportData } from "@/lib/doctor-report-data";
import { resolveGlucoseUnit, convertGlucose } from "@/lib/glucose";
import {
  LOINC_SYSTEM,
  HEALTHKIT_CODESYSTEM,
  UCUM_SYSTEM,
  MEASUREMENT_LOINC,
  BP_PANEL_LOINC,
  BP_SYS_LOINC,
  BP_DIA_LOINC,
  BP_UNIT,
  GLUCOSE_LOINC,
  MEDICATION_ADHERENCE_LOINC,
  MOOD_LOINC,
  LMP_LOINC,
  CYCLE_LENGTH_LOINC,
  PERIOD_LENGTH_LOINC,
  type LoincMapping,
} from "@/lib/fhir/loinc-map";
import type {
  FhirCodeableConcept,
  FhirObservation,
  FhirMedicationStatement,
  FhirMedicationAdministration,
  FhirDosage,
  FhirPatient,
  FhirCoverage,
  FhirOrganization,
  FhirReference,
} from "@/lib/fhir/types";

/** Patient identity not carried in `DoctorReportData` (KVNR is encrypted). */
export interface FhirPatientIdentity {
  /** German KVNR (decrypted by the route). */
  insuranceNumber: string | null;
}

/** KVNR identifier namespace per the gematik SID. */
const KVNR_SYSTEM = "http://fhir.de/sid/gkv/kvid-10";

/** German insurer institution-number (IKNR) identifier namespace. */
const IKNR_SYSTEM = "http://fhir.de/sid/arge-ik/iknr";

/**
 * v1.9.0 — drug-coding system URIs. ATC is the portable WHO default
 * (the iOS export emits the identical URI); RxNorm is the secondary US
 * coding. Both are additive `coding[]` entries on the same concept; the
 * free-text `.text` (the user's medication name) stays the anchor.
 */
export const ATC_SYSTEM = "http://www.whocc.no/atc";
/**
 * German national ATC URI maintained by the BfArM. Same ATC classification
 * as WHO under a national CodeSystem; emitted as an ADDITIONAL coding (never
 * a replacement) when a German-region export is requested, so the WHO entry
 * stays first and byte-identical for every consumer.
 */
const ATC_BFARM_SYSTEM = "http://fhir.de/CodeSystem/bfarm/atc";
const RXNORM_SYSTEM = "http://www.nlm.nih.gov/research/umls/rxnorm";
/** SNOMED CT URI. Concept ids are referenced (not redistributed) in FHIR instances. */
export const SNOMED_SYSTEM = "http://snomed.info/sct";

/**
 * The app locales for which a health-record export defaults `germanAtc` on
 * (the additive BfArM ATC coding). The export route derives the flag from
 * the user's locale against this set; the capabilities endpoint surfaces it
 * verbatim so a client can predict the coding without a round-trip. Keeping
 * it here — beside the BfArM URI it gates — makes the two move together.
 */
export const GERMAN_ATC_DEFAULT_LOCALES = ["de"] as const;

/** Options threaded from the export route into the emitters. Additive, all defaulted. */
export interface FhirBuildOptions {
  /**
   * When true, additionally emit the German BfArM ATC URI alongside the WHO
   * entry on each medication concept. The WHO coding stays first and
   * byte-identical; this only appends a second URI for the same leaf code.
   * Defaults off; the route turns it on for a German-region export.
   */
  germanAtc?: boolean;
}

/**
 * Build a `medicationCodeableConcept` from a medication's free-text name
 * plus its optional user-asserted codes. ATC is emitted first (primary),
 * RxNorm second (secondary); both are omitted when NULL, collapsing to
 * exactly the pre-v1.9.0 `{ text }` shape. Never machine-guesses a code.
 * When `germanAtc` is set, the same ATC leaf code is also published under
 * the BfArM URI AFTER the WHO entry — additive, never reordering WHO.
 */
function medicationConcept(
  name: string,
  atcCode: string | null | undefined,
  rxNormCode: string | null | undefined,
  germanAtc: boolean,
): FhirCodeableConcept {
  const coding: NonNullable<FhirCodeableConcept["coding"]> = [];
  if (atcCode) {
    coding.push({ system: ATC_SYSTEM, code: atcCode, display: name });
    if (germanAtc) {
      coding.push({ system: ATC_BFARM_SYSTEM, code: atcCode, display: name });
    }
  }
  if (rxNormCode) {
    coding.push({ system: RXNORM_SYSTEM, code: rxNormCode });
  }
  return coding.length > 0 ? { coding, text: name } : { text: name };
}

/**
 * v1.9.0 — UCUM codes for the dose units HealthLog stores. The display
 * `unit` is always the user's original string; the UCUM `code` is set
 * only for an unambiguous mapping so a consumer that resolves UCUM never
 * sees a guessed code. An unmapped unit drops `code` (and `system`) and
 * keeps just the human-readable `unit` — conformant, just not coded.
 */
const UCUM_DOSE_CODES: Record<string, string> = {
  mg: "mg",
  g: "g",
  mcg: "ug",
  µg: "ug",
  ug: "ug",
  ml: "mL",
  mL: "mL",
};

function doseQuantity(value: number, unit: string): {
  value: number;
  unit: string;
  system?: string;
  code?: string;
} {
  const ucum = UCUM_DOSE_CODES[unit];
  return ucum
    ? { value, unit, system: UCUM_SYSTEM, code: ucum }
    : { value, unit };
}

/**
 * Route of administration derived from the medication's delivery form,
 * carrying an additive SNOMED CT `coding` alongside the existing `.text`
 * anchor. HealthLog injections are subcutaneous (the injection-site picker
 * exists for the GLP-1 / self-injection workflow), so `INJECTION` maps to
 * the subcutaneous route. Returns `undefined` for an unknown / absent form
 * so no empty route is emitted.
 */
const ROUTE_SNOMED: Record<string, { code: string; display: string }> = {
  ORAL: { code: "26643006", display: "Oral route" },
  INJECTION: { code: "34206005", display: "Subcutaneous route" },
};

function routeConcept(
  deliveryForm: string | null,
): FhirCodeableConcept | undefined {
  const text =
    deliveryForm === "ORAL"
      ? "Oral"
      : deliveryForm === "INJECTION"
        ? "Injection"
        : undefined;
  if (!text) return undefined;
  const snomed = ROUTE_SNOMED[deliveryForm as string];
  return snomed
    ? {
        coding: [
          { system: SNOMED_SYSTEM, code: snomed.code, display: snomed.display },
        ],
        text,
      }
    : { text };
}

/**
 * Administration body-site keyed on the raw `InjectionSite` enum value,
 * carrying an additive SNOMED CT body-region `coding` alongside the `.text`
 * anchor. The map collapses the eight enum members to three gross body-region
 * concepts (abdomen / thigh / upper arm); laterality (left/right) and the
 * abdominal quadrant are NOT lateralised SNOMED concepts here — they are
 * preserved verbatim in the human-readable `.text` (the raw enum value), so
 * no information is lost.
 */
const SITE_SNOMED: Record<string, { code: string; display: string }> = {
  ABDOMEN_LEFT: { code: "818983003", display: "Abdomen structure" },
  ABDOMEN_RIGHT: { code: "818983003", display: "Abdomen structure" },
  ABDOMEN_UPPER_LEFT: { code: "818983003", display: "Abdomen structure" },
  ABDOMEN_UPPER_RIGHT: { code: "818983003", display: "Abdomen structure" },
  THIGH_LEFT: { code: "68367000", display: "Thigh structure" },
  THIGH_RIGHT: { code: "68367000", display: "Thigh structure" },
  UPPER_ARM_LEFT: { code: "40983000", display: "Structure of upper arm" },
  UPPER_ARM_RIGHT: { code: "40983000", display: "Structure of upper arm" },
};

function siteConcept(injectionSite: string): FhirCodeableConcept {
  const snomed = SITE_SNOMED[injectionSite];
  // Preserve the full enum value (incl. laterality) as the readable anchor.
  const text = injectionSite;
  return snomed
    ? {
        coding: [
          { system: SNOMED_SYSTEM, code: snomed.code, display: snomed.display },
        ],
        text,
      }
    : { text };
}

function codeableFromMapping(m: LoincMapping): FhirCodeableConcept {
  if (m.loinc) {
    // HealthKit placeholder codes have no published LOINC term; they must not
    // sit under the LOINC namespace (a non-LOINC code there is a conformance
    // violation). Route them onto the shared custom CodeSystem instead —
    // byte-aligned with the iOS exporter.
    const system = m.loinc.startsWith("HKQuantityTypeIdentifier")
      ? HEALTHKIT_CODESYSTEM
      : LOINC_SYSTEM;
    return {
      coding: [{ system, code: m.loinc, display: m.display }],
      text: m.display,
    };
  }
  // No stable LOINC — local text-only concept (documented fallback).
  return { text: m.display };
}

/** v1.10.0 — English display per persisted wellness-score type (FHIR
 *  text-only concept; the score has no published LOINC term). */
const WELLNESS_SCORE_DISPLAY: Record<string, string> = {
  RECOVERY_SCORE: "Recovery score",
  STRESS_SCORE: "Stress score",
  STRAIN_SCORE: "Strain score",
};

function categoryConcept(category: string): FhirCodeableConcept {
  return {
    coding: [
      {
        system: "http://terminology.hl7.org/CodeSystem/observation-category",
        code: category,
      },
    ],
  };
}

/** Latest `{ value, measuredAt }` for a type, or null when no rows. */
function latestReading(
  data: DoctorReportData,
  type: string,
): { value: number; measuredAt: string } | null {
  const series = data.measurements[type];
  if (!series || series.length === 0) return null;
  return series[series.length - 1];
}

/** Local-`#`-ref / patient anchor id shared by every subject reference. */
export const PATIENT_RESOURCE_ID = "patient-1";
const patientRef: FhirReference = {
  reference: `Patient/${PATIENT_RESOURCE_ID}`,
};

/**
 * Emit the `Patient` resource from the aggregated report data + decrypted
 * identity. Carries display name, gender, birth date and the KVNR identifier
 * when present; every absent field collapses its slot.
 */
export function patientResource(
  data: DoctorReportData,
  identity: FhirPatientIdentity,
): FhirPatient {
  const patient: FhirPatient = {
    resourceType: "Patient",
    id: PATIENT_RESOURCE_ID,
  };
  const displayName = data.patient.fullName ?? data.patient.username ?? null;
  if (displayName) patient.name = [{ text: displayName }];
  if (data.patient.gender) {
    patient.gender = data.patient.gender === "MALE" ? "male" : "female";
  }
  if (data.patient.dateOfBirth) {
    patient.birthDate = data.patient.dateOfBirth.slice(0, 10);
  }
  if (identity.insuranceNumber) {
    patient.identifier = [
      { system: KVNR_SYSTEM, value: identity.insuranceNumber },
    ];
  }
  return patient;
}

/**
 * Emit the `Coverage` resource, or `null` when there is no payor signal at
 * all. v1.9.0 — emitted whenever ANY payor signal is present: an insurer
 * name, an IKNR, OR a bare KVNR. The KVNR-only case aligns the server with
 * the iOS exporter (which emits a Coverage on a bare member id); it carries
 * the `subscriberId` with no contained payor Organization. When an insurer
 * name and/or IKNR is known, the payor is a CONTAINED Organization referenced
 * by a local `#`-ref. The KVNR stays on `Patient.identifier` and doubles as
 * the `subscriberId` (member id).
 */
export function coverageResource(
  data: DoctorReportData,
  identity: FhirPatientIdentity,
): FhirCoverage | null {
  const insurerName = data.patient.insurerName ?? null;
  const insurerIkNumber = data.patient.insurerIkNumber ?? null;
  const hasPayorOrg = Boolean(insurerName || insurerIkNumber);
  if (!hasPayorOrg && !identity.insuranceNumber) return null;

  const coverage: FhirCoverage = {
    resourceType: "Coverage",
    id: "coverage-1",
    status: "active",
    beneficiary: patientRef,
  };
  if (hasPayorOrg) {
    const orgId = "insurer-org-1";
    const payorOrg: FhirOrganization = {
      resourceType: "Organization",
      id: orgId,
    };
    if (insurerIkNumber) {
      payorOrg.identifier = [{ system: IKNR_SYSTEM, value: insurerIkNumber }];
    }
    if (insurerName) payorOrg.name = insurerName;
    coverage.contained = [payorOrg];
    coverage.payor = [{ reference: `#${orgId}` }];
  }
  if (identity.insuranceNumber) {
    coverage.subscriberId = identity.insuranceNumber;
  }
  return coverage;
}

/**
 * Emit every `Observation` from the aggregated report data, in the canonical
 * order: one latest reading per measurement type, the blood-pressure panel,
 * the computed BMI, glucose per context, medication adherence, the opt-in
 * mood average, then the descriptive wellness composites under `survey`.
 *
 * The `obs-N` ids run as one continuous sequence across all of these so the
 * document builder's references stay stable; a `searchset` caller can filter
 * the returned array by `category`/`code` without re-numbering.
 */
export function observationsFromReportData(
  data: DoctorReportData,
  _identity: FhirPatientIdentity,
  options: FhirBuildOptions = {},
): FhirObservation[] {
  void options;
  const observations: FhirObservation[] = [];
  let obsSeq = 0;
  const push = (obs: FhirObservation) => observations.push(obs);

  // --- Vital-sign + activity Observations (one latest reading per type) --
  const glucoseUnit = resolveGlucoseUnit(data.glucoseUnit ?? null);

  for (const [type, mapping] of Object.entries(MEASUREMENT_LOINC)) {
    // BMI is emitted once by the computed-BMI block below (matching the PDF's
    // BMI line); skip the stored BODY_MASS_INDEX series here to avoid a
    // duplicate Observation.
    if (type === "BODY_MASS_INDEX") continue;
    const reading = latestReading(data, type);
    if (!reading) continue;
    // SLEEP_DURATION is stored in MINUTES; the iOS-locked UCUM unit is `h`, so
    // emit the value in hours to keep value and unit consistent. The PDF reads
    // the raw series independently and is unaffected.
    const value =
      type === "SLEEP_DURATION"
        ? Math.round((reading.value / 60) * 100) / 100
        : reading.value;
    obsSeq += 1;
    push({
      resourceType: "Observation",
      id: `obs-${obsSeq}`,
      status: "final",
      category: [categoryConcept(mapping.category)],
      code: codeableFromMapping(mapping),
      subject: patientRef,
      effectiveDateTime: reading.measuredAt,
      valueQuantity: {
        value,
        unit: mapping.unit,
        system: UCUM_SYSTEM,
        code: mapping.unit,
      },
    });
  }

  // --- Blood-pressure panel (sys + dia components) -----------------------
  const sys = latestReading(data, "BLOOD_PRESSURE_SYS");
  const dia = latestReading(data, "BLOOD_PRESSURE_DIA");
  if (sys && dia) {
    obsSeq += 1;
    push({
      resourceType: "Observation",
      id: `obs-${obsSeq}`,
      status: "final",
      category: [categoryConcept("vital-signs")],
      code: {
        coding: [
          {
            system: LOINC_SYSTEM,
            code: BP_PANEL_LOINC,
            display: "Blood pressure panel",
          },
        ],
        text: "Blood pressure",
      },
      subject: patientRef,
      // Use the systolic reading's timestamp as the panel effective time.
      effectiveDateTime: sys.measuredAt,
      component: [
        {
          code: {
            coding: [
              { system: LOINC_SYSTEM, code: BP_SYS_LOINC, display: "Systolic" },
            ],
          },
          valueQuantity: {
            value: sys.value,
            unit: BP_UNIT,
            system: UCUM_SYSTEM,
            code: BP_UNIT,
          },
        },
        {
          code: {
            coding: [
              { system: LOINC_SYSTEM, code: BP_DIA_LOINC, display: "Diastolic" },
            ],
          },
          valueQuantity: {
            value: dia.value,
            unit: BP_UNIT,
            system: UCUM_SYSTEM,
            code: BP_UNIT,
          },
        },
      ],
    });
  }

  // --- Computed BMI Observation (matches the PDF's BMI line) -------------
  if (data.bmi !== null && data.bmi !== undefined) {
    obsSeq += 1;
    push({
      resourceType: "Observation",
      id: `obs-${obsSeq}`,
      status: "final",
      category: [categoryConcept("vital-signs")],
      code: {
        coding: [
          {
            system: LOINC_SYSTEM,
            code: "39156-5",
            display: "Body mass index (BMI) [Ratio]",
          },
        ],
        text: "Body mass index (BMI) [Ratio]",
      },
      subject: patientRef,
      effectiveDateTime: data.period.end,
      valueQuantity: {
        value: data.bmi,
        unit: "kg/m2",
        system: UCUM_SYSTEM,
        code: "kg/m2",
      },
    });
  }

  // --- Glucose Observations (per context, user display unit) -------------
  for (const [ctx, stat] of Object.entries(data.glucoseStats)) {
    const map = GLUCOSE_LOINC[ctx];
    if (!map) continue;
    obsSeq += 1;
    push({
      resourceType: "Observation",
      id: `obs-${obsSeq}`,
      status: "final",
      category: [categoryConcept("laboratory")],
      code: {
        coding: [{ system: LOINC_SYSTEM, code: map.loinc, display: map.display }],
        text: map.display,
      },
      subject: patientRef,
      effectiveDateTime: data.period.end,
      valueQuantity: {
        value: convertGlucose(stat.latest, glucoseUnit),
        unit: glucoseUnit,
        system: UCUM_SYSTEM,
        code: glucoseUnit === "mmol/L" ? "mmol/L" : "mg/dL",
      },
    });
  }

  // --- Medication-adherence Observations (one per medication) ------------
  for (const [name, comp] of Object.entries(data.compliance)) {
    if (comp.total <= 0) continue;
    obsSeq += 1;
    const rate = Math.round((comp.taken / comp.total) * 1000) / 10;
    push({
      resourceType: "Observation",
      id: `obs-${obsSeq}`,
      status: "final",
      category: [categoryConcept("activity")],
      code: {
        coding: [
          {
            system: LOINC_SYSTEM,
            code: MEDICATION_ADHERENCE_LOINC,
            display: "Medication adherence",
          },
        ],
        text: `Medication adherence — ${name}`,
      },
      subject: patientRef,
      effectiveDateTime: data.period.end,
      valueQuantity: { value: rate, unit: "%", system: UCUM_SYSTEM, code: "%" },
    });
  }

  // --- Mood Observation (opt-in only; absent when toggle off) ------------
  if (data.mood) {
    obsSeq += 1;
    push({
      resourceType: "Observation",
      id: `obs-${obsSeq}`,
      status: "final",
      category: [categoryConcept("vital-signs")],
      code: {
        coding: [{ system: LOINC_SYSTEM, code: MOOD_LOINC, display: "Mood" }],
        text: "Mood (average over period)",
      },
      subject: patientRef,
      effectiveDateTime: data.period.end,
      valueQuantity: {
        value: Math.round(data.mood.avg * 10) / 10,
        unit: "{score}",
        system: UCUM_SYSTEM,
        code: "{score}",
      },
    });
  }

  // --- Wellness-score Observations (descriptive composites) --------------
  // v1.10.0 — the server-derived nightly scores (recovery / stress /
  // strain). They have no published LOINC term and are NOT clinical
  // findings, so each is emitted under the `survey` category with a
  // text-only concept and an explicit "descriptive, not a clinical
  // assessment" note — a physician's FHIR viewer never mistakes a band for
  // a diagnosis. Absent when the aggregator emitted no scores.
  if (data.wellnessScores && data.wellnessScores.length > 0) {
    for (const s of data.wellnessScores) {
      obsSeq += 1;
      push({
        resourceType: "Observation",
        id: `obs-${obsSeq}`,
        status: "final",
        category: [categoryConcept("survey")],
        code: { text: WELLNESS_SCORE_DISPLAY[s.type] ?? "Wellness score" },
        subject: patientRef,
        effectiveDateTime: s.latestAt,
        valueQuantity: {
          value: s.latest,
          unit: "{score}",
          system: UCUM_SYSTEM,
          code: "{score}",
        },
        note: [
          {
            text: "Descriptive wellness score (0–100) computed from tracked signals; not a clinical assessment or diagnosis.",
          },
        ],
      });
    }
  }

  return observations;
}

/**
 * Phase → SNOMED-free display string for the current-phase Observation.
 * The four cycle phases have no single published LOINC answer-list term we
 * commit to, so the phase rides a text-only concept under the `survey`
 * category (a clinician's viewer reads it as a descriptive finding, not a
 * coded diagnosis), mirroring the wellness-score stance.
 */
const CYCLE_PHASE_DISPLAY: Record<string, string> = {
  MENSTRUAL: "Menstrual phase",
  FOLLICULAR: "Follicular phase",
  OVULATORY: "Ovulatory phase",
  LUTEAL: "Luteal phase",
};

/**
 * v1.15.0 — emit the cycle / reproductive-health Observations from the
 * opt-in cycle summary: LMP (LOINC 8665-2, a date value), average cycle
 * length (64700-8, days), average period length (64698-4, days), and the
 * current phase (text-only survey finding). Absent when the aggregator
 * carried no cycle summary (toggle off or no observed cycle). Ids run
 * `obs-cycle-N` so they never collide with the main `obs-N` sequence.
 */
export function cycleObservationsFromReportData(
  data: DoctorReportData,
): FhirObservation[] {
  const cycle = data.cycle;
  if (!cycle) return [];
  const observations: FhirObservation[] = [];
  let seq = 0;
  const next = () => `obs-cycle-${(seq += 1)}`;
  const effective = data.period.end;

  if (cycle.lastPeriodStart) {
    observations.push({
      resourceType: "Observation",
      id: next(),
      status: "final",
      category: [categoryConcept("survey")],
      code: {
        coding: [
          {
            system: LOINC_SYSTEM,
            code: LMP_LOINC,
            display: "Last menstrual period start date",
          },
        ],
        text: "Last menstrual period (LMP)",
      },
      subject: patientRef,
      effectiveDateTime: effective,
      // LMP is a date value; emit the YYYY-MM-DD as a FHIR `date`.
      valueDateTime: cycle.lastPeriodStart,
    });
  }

  if (cycle.averageCycleLengthDays !== null) {
    observations.push({
      resourceType: "Observation",
      id: next(),
      status: "final",
      category: [categoryConcept("survey")],
      code: {
        coding: [
          {
            system: LOINC_SYSTEM,
            code: CYCLE_LENGTH_LOINC,
            display: "Menstrual cycle length",
          },
        ],
        text: "Average menstrual cycle length",
      },
      subject: patientRef,
      effectiveDateTime: effective,
      valueQuantity: {
        value: cycle.averageCycleLengthDays,
        unit: "d",
        system: UCUM_SYSTEM,
        code: "d",
      },
      ...(cycle.cycleLengthVariabilityDays !== null
        ? {
            note: [
              {
                text: `Cycle-length variability (median absolute deviation): ±${cycle.cycleLengthVariabilityDays} days over ${cycle.observedCycleCount} observed cycle(s).`,
              },
            ],
          }
        : {}),
    });
  }

  if (cycle.averagePeriodLengthDays !== null) {
    observations.push({
      resourceType: "Observation",
      id: next(),
      status: "final",
      category: [categoryConcept("survey")],
      code: {
        coding: [
          {
            system: LOINC_SYSTEM,
            code: PERIOD_LENGTH_LOINC,
            display: "Length of menses",
          },
        ],
        text: "Average period length",
      },
      subject: patientRef,
      effectiveDateTime: effective,
      valueQuantity: {
        value: cycle.averagePeriodLengthDays,
        unit: "d",
        system: UCUM_SYSTEM,
        code: "d",
      },
    });
  }

  if (cycle.currentPhase) {
    observations.push({
      resourceType: "Observation",
      id: next(),
      status: "final",
      category: [categoryConcept("survey")],
      code: { text: "Current menstrual cycle phase" },
      subject: patientRef,
      effectiveDateTime: effective,
      valueString: CYCLE_PHASE_DISPLAY[cycle.currentPhase] ?? cycle.currentPhase,
      note: [
        {
          text: "Phase derived from logged cycle boundaries; descriptive, not a clinical assessment.",
        },
      ],
    });
  }

  return observations;
}

/**
 * Emit one `MedicationStatement` per active medication. v1.9.0 — additive
 * ATC (primary) / RxNorm (secondary) codings when the user stored them;
 * falls back to the text-only concept otherwise. Ids run `med-1..N`.
 */
export function medicationStatementsFromReportData(
  data: DoctorReportData,
  options: FhirBuildOptions = {},
): FhirMedicationStatement[] {
  const germanAtc = options.germanAtc ?? false;
  const statements: FhirMedicationStatement[] = [];
  let medSeq = 0;
  for (const med of data.medications) {
    medSeq += 1;
    const id = `med-${medSeq}`;
    const stmt: FhirMedicationStatement = {
      resourceType: "MedicationStatement",
      id,
      status: "active",
      medicationCodeableConcept: medicationConcept(
        med.name,
        med.atcCode,
        med.rxNormCode,
        germanAtc,
      ),
      subject: patientRef,
    };
    if (med.dose) stmt.dosage = [{ text: med.dose }];
    statements.push(stmt);
  }
  return statements;
}

/**
 * Emit one `MedicationAdministration` per acted intake: `completed` (taken)
 * or `not-done` (explicitly skipped). Pending / missed slots and soft-deleted
 * tombstones are excluded upstream by the aggregator. The concept reuses the
 * same ATC/RxNorm coding as the statement so each administration is
 * self-describing without resolving a reference (no `partOf` / `request`
 * coupling). A `dosage` is emitted ONLY when a structured `dose` Quantity is
 * available; a dosage with only `.text` would violate the R4 dose-or-rate
 * invariant. Ids run `medadmin-1..N`.
 */
export function medicationAdministrationsFromReportData(
  data: DoctorReportData,
  options: FhirBuildOptions = {},
): FhirMedicationAdministration[] {
  const germanAtc = options.germanAtc ?? false;
  const administrations: FhirMedicationAdministration[] = [];
  let adminSeq = 0;
  for (const admin of data.medicationAdministrations ?? []) {
    adminSeq += 1;
    const id = `medadmin-${adminSeq}`;
    const resource: FhirMedicationAdministration = {
      resourceType: "MedicationAdministration",
      id,
      status: admin.status,
      medicationCodeableConcept: medicationConcept(
        admin.medicationName,
        admin.atcCode,
        admin.rxNormCode,
        germanAtc,
      ),
      subject: patientRef,
      effectiveDateTime: admin.effectiveAt,
    };

    // Dosage: only when a structured dose Quantity exists. Carry the
    // free-text dose + route + site alongside it. Route and site each carry
    // an additive SNOMED coding plus the existing `.text` anchor.
    if (admin.dose) {
      const dosage: FhirDosage = {
        dose: doseQuantity(admin.dose.value, admin.dose.unit),
      };
      if (admin.doseText) dosage.text = admin.doseText;
      const route = routeConcept(admin.deliveryForm);
      if (route) dosage.route = route;
      if (admin.injectionSite) dosage.site = siteConcept(admin.injectionSite);
      resource.dosage = dosage;
    }

    administrations.push(resource);
  }
  return administrations;
}
