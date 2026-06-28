import { describe, it, expect } from "vitest";

import {
  allergyIntoleranceResources,
  familyMemberHistoryResources,
} from "@/lib/fhir/records";
import type { AllergyDTO, FamilyHistoryEntryDTO } from "@/lib/records/dto";

function allergy(overrides: Partial<AllergyDTO> = {}): AllergyDTO {
  return {
    id: "a1",
    substance: "Penicillin",
    category: "MEDICATION",
    type: "ALLERGY",
    severity: "SEVERE",
    status: "ACTIVE",
    onsetAt: "2020-01-02T00:00:00.000Z",
    reaction: "Anaphylaxis",
    note: null,
    createdAt: "2020-01-02T00:00:00.000Z",
    updatedAt: "2020-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function family(
  overrides: Partial<FamilyHistoryEntryDTO> = {},
): FamilyHistoryEntryDTO {
  return {
    id: "f1",
    relationship: "MOTHER",
    condition: "Type 2 diabetes",
    ageAtOnset: 55,
    note: null,
    createdAt: "2020-01-02T00:00:00.000Z",
    updatedAt: "2020-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("allergyIntoleranceResources", () => {
  it("maps a record to a patient-reported AllergyIntolerance with the label on code.text", () => {
    const [r] = allergyIntoleranceResources([allergy()]);
    expect(r.resourceType).toBe("AllergyIntolerance");
    expect(r.id).toBe("allergy-1");
    expect(r.code).toEqual({ text: "Penicillin" });
    expect(r.type).toBe("allergy");
    expect(r.category).toEqual(["medication"]);
    expect(r.criticality).toBe("high");
    expect(r.clinicalStatus?.coding?.[0].code).toBe("active");
    // Patient-reported, never clinician-confirmed.
    expect(r.verificationStatus?.coding?.[0].code).toBe("unconfirmed");
    expect(r.patient.reference).toBe("Patient/patient-1");
    expect(r.onsetDateTime).toBe("2020-01-02T00:00:00.000Z");
    expect(r.reaction?.[0].manifestation[0]).toEqual({ text: "Anaphylaxis" });
    expect(r.reaction?.[0].severity).toBe("severe");
    // First note is the non-diagnostic guard rail.
    expect(r.note?.[0].text).toMatch(/not a clinical diagnosis/i);
  });

  it("omits category for OTHER and reaction when no free-text reaction", () => {
    const [r] = allergyIntoleranceResources([
      allergy({ category: "OTHER", reaction: null, severity: null }),
    ]);
    expect(r.category).toBeUndefined();
    expect(r.reaction).toBeUndefined();
    expect(r.criticality).toBeUndefined();
  });

  it("never machine-guesses a substance code", () => {
    const [r] = allergyIntoleranceResources([allergy()]);
    expect(r.code.coding).toBeUndefined();
  });
});

describe("familyMemberHistoryResources", () => {
  it("maps a record to a completed FamilyMemberHistory with the label on condition.code.text", () => {
    const [r] = familyMemberHistoryResources([family()]);
    expect(r.resourceType).toBe("FamilyMemberHistory");
    expect(r.id).toBe("famhist-1");
    expect(r.status).toBe("completed");
    expect(r.relationship.coding?.[0].code).toBe("MTH");
    expect(r.condition?.[0].code).toEqual({ text: "Type 2 diabetes" });
    expect(r.condition?.[0].onsetAge).toEqual({
      value: 55,
      unit: "a",
      system: "http://unitsofmeasure.org",
      code: "a",
    });
    expect(r.note?.[0].text).toMatch(/not a clinical diagnosis/i);
  });

  it("falls back to the generic family-member RoleCode for OTHER and omits onsetAge when unknown", () => {
    const [r] = familyMemberHistoryResources([
      family({ relationship: "OTHER", ageAtOnset: null }),
    ]);
    expect(r.relationship.coding?.[0].code).toBe("FAMMEMB");
    expect(r.condition?.[0].onsetAge).toBeUndefined();
  });
});
