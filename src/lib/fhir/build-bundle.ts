/**
 * v1.7.0 — HL7 FHIR R4 document-Bundle builder for the health-record export.
 *
 * Pure function: takes the SAME `DoctorReportData` the PDF renderer consumes
 * (assembled by `collectDoctorReportData`) plus the decrypted patient
 * identity, and emits a `Bundle` of `type: "document"` — a leading
 * `Composition` "cover page", the `Patient`, then one `Observation` per
 * selected vital / glucose context / mood + one `MedicationStatement` per
 * active medication.
 *
 * Because it reuses the PDF aggregator, the FHIR export and the PDF describe
 * identical numbers by construction (the source-of-truth property the two
 * PDF endpoints already share).
 *
 * No FHIR SDK, no `@types/fhir` — narrow hand-rolled interfaces only
 * (`./types`), matching the project's "hand-rolled over the documented wire"
 * convention. The `Composition.text` narrative is escaped plain text, never
 * user-supplied HTML (no markdown library, no `dangerouslySetInnerHTML`).
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
  type LoincMapping,
} from "@/lib/fhir/loinc-map";
import type {
  FhirBundle,
  FhirBundleEntry,
  FhirCodeableConcept,
  FhirObservation,
  FhirMedicationStatement,
  FhirMedicationAdministration,
  FhirDosage,
  FhirPatient,
  FhirCoverage,
  FhirOrganization,
  FhirComposition,
  FhirDiagnosticReport,
  FhirReference,
  FhirResource,
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
const ATC_SYSTEM = "http://www.whocc.no/atc";
/**
 * German national ATC URI maintained by the BfArM. Same ATC classification
 * as WHO under a national CodeSystem; emitted as an ADDITIONAL coding (never
 * a replacement) when a German-region export is requested, so the WHO entry
 * stays first and byte-identical for every consumer.
 */
const ATC_BFARM_SYSTEM = "http://fhir.de/CodeSystem/bfarm/atc";
const RXNORM_SYSTEM = "http://www.nlm.nih.gov/research/umls/rxnorm";
/** SNOMED CT URI. Concept ids are referenced (not redistributed) in FHIR instances. */
const SNOMED_SYSTEM = "http://snomed.info/sct";

/** Options threaded from the export route into the builder. Additive, all defaulted. */
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

/** Escape the five XML-significant characters for the xhtml narrative. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

/**
 * Build a FHIR R4 document Bundle from the aggregated report data.
 *
 * `now` is injectable for deterministic tests.
 */
export function buildFhirDocumentBundle(
  data: DoctorReportData,
  identity: FhirPatientIdentity,
  now: Date = new Date(),
  options: FhirBuildOptions = {},
): FhirBundle {
  const germanAtc = options.germanAtc ?? false;
  const patientId = "patient-1";
  const patientRef: FhirReference = { reference: `Patient/${patientId}` };
  const entries: FhirBundleEntry[] = [];
  const observationRefs: FhirReference[] = [];
  const medicationRefs: FhirReference[] = [];

  // --- Patient -----------------------------------------------------------
  const patient: FhirPatient = {
    resourceType: "Patient",
    id: patientId,
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
  entries.push({ fullUrl: `urn:uuid:${patientId}`, resource: patient });

  // --- Coverage (insurer; sits right after the Patient) ------------------
  // v1.9.0 — emitted whenever ANY payor signal is present: an insurer
  // name, an IKNR, OR a bare KVNR. The KVNR-only case aligns the server
  // with the iOS exporter (which emits a Coverage on a bare member id);
  // it carries the `subscriberId` with no contained payor Organization.
  // When an insurer name and/or IKNR is known, the payor is a CONTAINED
  // Organization referenced by a local `#`-ref. The KVNR stays on
  // `Patient.identifier` and doubles as the `subscriberId` (member id).
  const insurerName = data.patient.insurerName ?? null;
  const insurerIkNumber = data.patient.insurerIkNumber ?? null;
  const hasPayorOrg = Boolean(insurerName || insurerIkNumber);
  if (hasPayorOrg || identity.insuranceNumber) {
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
    entries.push({
      fullUrl: `urn:uuid:${coverage.id}`,
      resource: coverage,
    });
  }

  let obsSeq = 0;
  const pushObservation = (obs: FhirObservation) => {
    entries.push({ fullUrl: `urn:uuid:${obs.id}`, resource: obs });
    observationRefs.push({ reference: `Observation/${obs.id}` });
  };

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
    pushObservation({
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
    pushObservation({
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
    pushObservation({
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
    pushObservation({
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
    pushObservation({
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
    pushObservation({
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

  // --- MedicationStatement per active medication -------------------------
  let medSeq = 0;
  for (const med of data.medications) {
    medSeq += 1;
    const id = `med-${medSeq}`;
    const stmt: FhirMedicationStatement = {
      resourceType: "MedicationStatement",
      id,
      status: "active",
      // v1.9.0 — additive ATC (primary) / RxNorm (secondary) codings when
      // the user stored them; falls back to the text-only concept when
      // neither code is present (the pre-v1.9.0 shape).
      medicationCodeableConcept: medicationConcept(
        med.name,
        med.atcCode,
        med.rxNormCode,
        germanAtc,
      ),
      subject: patientRef,
    };
    if (med.dose) stmt.dosage = [{ text: med.dose }];
    entries.push({ fullUrl: `urn:uuid:${id}`, resource: stmt });
    medicationRefs.push({ reference: `MedicationStatement/${id}` });
  }

  // --- MedicationAdministration per acted intake -------------------------
  // One resource per intake the user actually actioned: `completed`
  // (taken) or `not-done` (explicitly skipped). Pending / missed slots and
  // soft-deleted tombstones are excluded upstream by the aggregator. The
  // concept reuses the same ATC/RxNorm coding as the statement so each
  // administration is self-describing without resolving a reference (no
  // `partOf` / `request` coupling — see the v1.9.0 design doc). A `dosage`
  // is emitted ONLY when a structured `dose` Quantity is available; a
  // dosage with only `.text` would violate the R4 dose-or-rate invariant.
  const administrationRefs: FhirReference[] = [];
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

    entries.push({ fullUrl: `urn:uuid:${id}`, resource });
    administrationRefs.push({ reference: `MedicationAdministration/${id}` });
  }

  // --- Composition (leading "cover" resource) ----------------------------
  // v1.9.0 — when the aggregator capped the administration set, disclose
  // it in the narrative so the export is honest: it carries the
  // most-recent N of M acted intakes, the oldest having been omitted.
  const truncation = data.medicationAdministrationsTruncation;
  const narrativeText = [
    `Health record for ${escapeXml(displayName ?? "patient")}.`,
    `Reporting period ${data.period.start.slice(0, 10)} to ${data.period.end.slice(0, 10)}.`,
    `${observationRefs.length} observation(s), ${medicationRefs.length} medication(s), ${administrationRefs.length} administration(s).`,
    ...(truncation
      ? [
          `Medication administrations truncated: showing the most recent ${truncation.included} of ${truncation.total} recorded; older entries omitted.`,
        ]
      : []),
  ].join(" ");

  const composition: FhirComposition = {
    resourceType: "Composition",
    id: "composition-1",
    status: "final",
    type: {
      coding: [
        {
          system: LOINC_SYSTEM,
          code: "11503-0",
          display: "Medical records",
        },
      ],
      text: "Health record",
    },
    subject: patientRef,
    date: now.toISOString(),
    author: [{ reference: "Device/healthlog", display: "HealthLog" }],
    title: "Health Record",
    // v1.9.0 — top-level document narrative (Coverage nit 2). Reuses the
    // same escaped plain-text summary the Vital-signs section carries, so
    // a strict US-Core-style validator sees a `Composition.text`.
    text: {
      status: "generated",
      div: `<div xmlns="http://www.w3.org/1999/xhtml">${escapeXml(narrativeText)}</div>`,
    },
    section: [
      {
        // Vital-signs section carries the narrative + every Observation ref,
        // matching the iOS Bundle graph ("Vital signs" + "Medications").
        title: "Vital signs",
        text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml">${escapeXml(narrativeText)}</div>` },
        entry: [patientRef, ...observationRefs],
      },
      // Medications section carries both the active-medication
      // statements and the per-dose administration records (v1.9.0), so
      // the iOS two-section graph ("Vital signs" + "Medications") is
      // preserved without adding a third section.
      ...(medicationRefs.length > 0 || administrationRefs.length > 0
        ? [
            {
              title: "Medications",
              entry: [...medicationRefs, ...administrationRefs],
            },
          ]
        : []),
    ],
  };

  // --- DiagnosticReport (vital-signs panel; routes all Observations) -----
  // Last entry in the Bundle, matching the iOS Bundle graph. `result[]`
  // references every emitted Observation.
  const diagnosticReport: FhirDiagnosticReport = {
    resourceType: "DiagnosticReport",
    id: "diagnostic-report-1",
    status: "final",
    code: {
      coding: [
        {
          system: LOINC_SYSTEM,
          code: "85353-1",
          display:
            "Vital signs, weight, height, head circumference, oxygen saturation and BMI panel",
        },
      ],
      text: "Vital signs panel",
    },
    subject: patientRef,
    effectivePeriod: { start: data.period.start, end: data.period.end },
    result: observationRefs,
  };

  // The Composition must be the FIRST entry in a document Bundle; the
  // DiagnosticReport is the LAST.
  const orderedEntries: FhirBundleEntry[] = [
    {
      fullUrl: `urn:uuid:${composition.id}`,
      resource: composition as FhirResource,
    },
    ...entries,
    {
      fullUrl: `urn:uuid:${diagnosticReport.id}`,
      resource: diagnosticReport as FhirResource,
    },
  ];

  return {
    resourceType: "Bundle",
    type: "document",
    timestamp: now.toISOString(),
    entry: orderedEntries,
  };
}
