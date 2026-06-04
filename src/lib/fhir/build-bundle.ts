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
 * v1.11.0 — the per-resource emitters (Observation / MedicationStatement /
 * MedicationAdministration / Patient / Coverage, with their LOINC/ATC/SNOMED/
 * UCUM codings + the `survey`-category wellness split) live in the shared
 * `./resources` module so the FHIR REST search routes reuse the SAME coding
 * logic. This builder composes them into the document Bundle.
 *
 * No FHIR SDK, no `@types/fhir` — narrow hand-rolled interfaces only
 * (`./types`), matching the project's "hand-rolled over the documented wire"
 * convention. The `Composition.text` narrative is escaped plain text, never
 * user-supplied HTML (no markdown library, no `dangerouslySetInnerHTML`).
 */
import type { DoctorReportData } from "@/lib/doctor-report-data";
import { LOINC_SYSTEM } from "@/lib/fhir/loinc-map";
import {
  type FhirBuildOptions,
  type FhirPatientIdentity,
  PATIENT_RESOURCE_ID,
  patientResource,
  coverageResource,
  observationsFromReportData,
  medicationStatementsFromReportData,
  medicationAdministrationsFromReportData,
} from "@/lib/fhir/resources";
import type {
  FhirBundle,
  FhirBundleEntry,
  FhirComposition,
  FhirDiagnosticReport,
  FhirReference,
  FhirResource,
} from "@/lib/fhir/types";

// Re-export the shared coding constants + option types so existing importers
// (capabilities + health-record routes) keep their `@/lib/fhir/build-bundle`
// import path. The single source of truth now lives in `./resources`.
export {
  ATC_SYSTEM,
  SNOMED_SYSTEM,
  GERMAN_ATC_DEFAULT_LOCALES,
} from "@/lib/fhir/resources";
export type { FhirBuildOptions, FhirPatientIdentity };

/** Escape the five XML-significant characters for the xhtml narrative. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  const patientRef: FhirReference = {
    reference: `Patient/${PATIENT_RESOURCE_ID}`,
  };
  const entries: FhirBundleEntry[] = [];
  const observationRefs: FhirReference[] = [];
  const medicationRefs: FhirReference[] = [];
  const administrationRefs: FhirReference[] = [];

  // --- Patient -----------------------------------------------------------
  const patient = patientResource(data, identity);
  entries.push({ fullUrl: `urn:uuid:${patient.id}`, resource: patient });

  // --- Coverage (insurer; sits right after the Patient) ------------------
  const coverage = coverageResource(data, identity);
  if (coverage) {
    entries.push({ fullUrl: `urn:uuid:${coverage.id}`, resource: coverage });
  }

  // --- Observations (vital / activity / lab / survey, in canonical order)-
  for (const obs of observationsFromReportData(data, identity, options)) {
    entries.push({ fullUrl: `urn:uuid:${obs.id}`, resource: obs });
    observationRefs.push({ reference: `Observation/${obs.id}` });
  }

  // --- MedicationStatement per active medication -------------------------
  for (const stmt of medicationStatementsFromReportData(data, options)) {
    entries.push({ fullUrl: `urn:uuid:${stmt.id}`, resource: stmt });
    medicationRefs.push({ reference: `MedicationStatement/${stmt.id}` });
  }

  // --- MedicationAdministration per acted intake -------------------------
  for (const admin of medicationAdministrationsFromReportData(data, options)) {
    entries.push({ fullUrl: `urn:uuid:${admin.id}`, resource: admin });
    administrationRefs.push({
      reference: `MedicationAdministration/${admin.id}`,
    });
  }

  // --- Composition (leading "cover" resource) ----------------------------
  // v1.9.0 — when the aggregator capped the administration set, disclose
  // it in the narrative so the export is honest: it carries the
  // most-recent N of M acted intakes, the oldest having been omitted.
  const displayName = data.patient.fullName ?? data.patient.username ?? null;
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
