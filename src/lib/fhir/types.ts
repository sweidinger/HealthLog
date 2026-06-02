/**
 * Narrow hand-rolled HL7 FHIR R4 type surface.
 *
 * Only the fields HealthLog emits — deliberately NOT the full `@types/fhir`
 * (multi-MB) or a FHIR SDK, mirroring the project's "hand-rolled fetch over
 * the documented wire, no vendor SDKs" convention for AI providers.
 *
 * Reference: https://hl7.org/fhir/R4/
 */

export interface FhirCoding {
  system?: string;
  code?: string;
  display?: string;
}

export interface FhirCodeableConcept {
  coding?: FhirCoding[];
  text?: string;
}

export interface FhirReference {
  reference: string;
  display?: string;
}

export interface FhirIdentifier {
  system?: string;
  value: string;
}

export interface FhirHumanName {
  text?: string;
  family?: string;
  given?: string[];
}

export interface FhirQuantity {
  value: number;
  unit?: string;
  system?: string; // UCUM: http://unitsofmeasure.org
  code?: string;
}

export interface FhirNarrative {
  status: "generated" | "extensions" | "additional" | "empty";
  div: string; // escaped xhtml
}

export interface FhirObservationComponent {
  code: FhirCodeableConcept;
  valueQuantity?: FhirQuantity;
  valueInteger?: number;
  valueString?: string;
}

export interface FhirPatient {
  resourceType: "Patient";
  id: string;
  identifier?: FhirIdentifier[];
  name?: FhirHumanName[];
  gender?: "male" | "female" | "other" | "unknown";
  birthDate?: string; // YYYY-MM-DD
}

export interface FhirObservation {
  resourceType: "Observation";
  id: string;
  status: "final";
  category?: FhirCodeableConcept[];
  code: FhirCodeableConcept;
  subject: FhirReference;
  effectiveDateTime?: string;
  valueQuantity?: FhirQuantity;
  valueInteger?: number;
  valueString?: string;
  component?: FhirObservationComponent[];
}

export interface FhirDosage {
  text?: string;
  /**
   * v1.9.0 — structured dose `Quantity`. On a `MedicationAdministration`
   * a `dosage` SHALL carry at least one of `dose` or `rate` (R4
   * invariant), so the builder only emits a `dosage` block when a `dose`
   * is available; a text-only dose stays on the `MedicationStatement`.
   */
  dose?: FhirQuantity;
  /** v1.9.0 — route of administration. Text-only by default (no SNOMED licence concern). */
  route?: FhirCodeableConcept;
  /** v1.9.0 — administration body-site (e.g. injection site). Text-only by default. */
  site?: FhirCodeableConcept;
}

export interface FhirPeriod {
  start?: string;
  end?: string;
}

export interface FhirMedicationStatement {
  resourceType: "MedicationStatement";
  id: string;
  status: "active" | "completed" | "stopped" | "unknown";
  medicationCodeableConcept: FhirCodeableConcept;
  subject: FhirReference;
  effectivePeriod?: FhirPeriod;
  dosage?: FhirDosage[];
}

export interface FhirMedicationAdministration {
  resourceType: "MedicationAdministration";
  id: string;
  /**
   * v1.9.0 — only `completed` (a taken dose) or `not-done` (an explicit
   * skip) are emitted; the exporter never asserts an administration for a
   * pending / missed slot or a soft-deleted tombstone.
   */
  status: "completed" | "not-done";
  /** Self-describing concept — the same ATC/RxNorm + text the statement carries. */
  medicationCodeableConcept: FhirCodeableConcept;
  subject: FhirReference;
  /**
   * `takenAt` for a `completed` administration, `scheduledFor` (the
   * intended instant) for a `not-done` skip.
   */
  effectiveDateTime: string;
  /** Single dosage (R4 `0..1`). Present only when a structured `dose` exists. */
  dosage?: FhirDosage;
}

export interface FhirDiagnosticReport {
  resourceType: "DiagnosticReport";
  id: string;
  status: "final";
  code: FhirCodeableConcept;
  subject: FhirReference;
  effectivePeriod?: FhirPeriod;
  result?: FhirReference[];
}

export interface FhirOrganization {
  resourceType: "Organization";
  id: string;
  identifier?: FhirIdentifier[];
  name?: string;
}

export interface FhirCoverage {
  resourceType: "Coverage";
  id: string;
  status: "active" | "cancelled" | "draft" | "entered-in-error";
  /** Inline payor Organization, referenced from `payor` via a local `#`-ref. */
  contained?: FhirOrganization[];
  /** The covered party — Reference(Patient). */
  beneficiary: FhirReference;
  /** German KVNR (the subscriber's member id), when present. */
  subscriberId?: string;
  /** Insurer(s) — Reference to the contained Organization. */
  payor?: FhirReference[];
}

export interface FhirCompositionSection {
  title: string;
  code?: FhirCodeableConcept;
  text?: FhirNarrative;
  entry?: FhirReference[];
}

export interface FhirComposition {
  resourceType: "Composition";
  id: string;
  status: "final";
  type: FhirCodeableConcept;
  subject: FhirReference;
  date: string;
  author: FhirReference[];
  title: string;
  /**
   * v1.9.0 — top-level document narrative. Section narrative is already
   * present; a strict US-Core-style validator additionally expects a
   * `Composition.text`. Reuses the same escaped plain-text summary.
   */
  text?: FhirNarrative;
  section?: FhirCompositionSection[];
}

export type FhirResource =
  | FhirComposition
  | FhirPatient
  | FhirCoverage
  | FhirObservation
  | FhirMedicationStatement
  | FhirMedicationAdministration
  | FhirDiagnosticReport;

export interface FhirBundleEntry {
  fullUrl?: string;
  resource: FhirResource;
}

export interface FhirBundle {
  resourceType: "Bundle";
  type: "document";
  timestamp: string;
  entry: FhirBundleEntry[];
}
