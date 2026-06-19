import { describe, it, expect } from "vitest";

import { computeGlucoseClinicalMetrics } from "@/lib/analytics/glucose-metrics";
import type { DoctorReportData } from "@/lib/doctor-report-data";

import { buildFhirDocumentBundle } from "../build-bundle";
import type { FhirObservation } from "../types";

const FIXED_NOW = new Date("2026-05-03T12:00:00.000Z");

function makeData(overrides?: Partial<DoctorReportData>): DoctorReportData {
  return {
    period: {
      days: 90,
      since: "2026-02-02T00:00:00.000Z",
      start: "2026-02-02T00:00:00.000Z",
      end: "2026-05-03T12:00:00.000Z",
    },
    patient: {
      username: "sample-user",
      dateOfBirth: "1985-06-15T00:00:00.000Z",
      gender: "MALE",
      heightCm: 182,
    },
    practiceName: null,
    measurements: {},
    stats: {},
    glucoseStats: {},
    glucoseRanges: {},
    glucoseClinical: computeGlucoseClinicalMetrics([], { now: FIXED_NOW }),
    glucoseUnit: "mg/dL",
    bmi: null,
    compliance: {},
    medications: [],
    mood: null,
    glp1: null,
    ...overrides,
  };
}

function observationsOf(bundle: ReturnType<typeof buildFhirDocumentBundle>) {
  return bundle.entry
    .map((e) => e.resource)
    .filter((r): r is FhirObservation => r.resourceType === "Observation");
}

describe("lab-result FHIR Observations", () => {
  const labResults: NonNullable<DoctorReportData["labResults"]> = [
    {
      panel: "Lipid panel",
      analyte: "LDL",
      value: 110,
      unit: "mg/dL",
      referenceLow: null,
      referenceHigh: 116,
      takenAt: "2026-04-20T08:00:00.000Z",
      count: 2,
    },
    {
      panel: null,
      analyte: "HbA1c",
      value: 5.4,
      unit: "%",
      referenceLow: 4,
      referenceHigh: 5.6,
      takenAt: "2026-04-21T08:00:00.000Z",
      count: 1,
    },
  ];

  it("emits one laboratory Observation per lab result", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({ labResults }),
      { insuranceNumber: "A123456780" },
      FIXED_NOW,
    );
    const labObs = observationsOf(bundle).filter((o) =>
      o.category?.some((c) =>
        c.coding?.some((code) => code.code === "laboratory"),
      ),
    );
    // Two lab observations (no glucose in this fixture).
    expect(labObs).toHaveLength(2);
  });

  it("maps the value, unit, and effective date onto the Observation", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({ labResults }),
      { insuranceNumber: "A123456780" },
      FIXED_NOW,
    );
    const ldl = observationsOf(bundle).find(
      (o) => o.code.text === "LDL (Lipid panel)",
    );
    expect(ldl).toBeDefined();
    expect(ldl?.valueQuantity?.value).toBe(110);
    expect(ldl?.valueQuantity?.unit).toBe("mg/dL");
    expect(ldl?.effectiveDateTime).toBe("2026-04-20T08:00:00.000Z");
  });

  it("emits a referenceRange with only the high bound when low is null", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({ labResults }),
      { insuranceNumber: "A123456780" },
      FIXED_NOW,
    );
    const ldl = observationsOf(bundle).find(
      (o) => o.code.text === "LDL (Lipid panel)",
    );
    expect(ldl?.referenceRange).toHaveLength(1);
    expect(ldl?.referenceRange?.[0].high?.value).toBe(116);
    expect(ldl?.referenceRange?.[0].low).toBeUndefined();
  });

  it("emits a referenceRange with both bounds", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({ labResults }),
      { insuranceNumber: "A123456780" },
      FIXED_NOW,
    );
    const a1c = observationsOf(bundle).find((o) => o.code.text === "HbA1c");
    expect(a1c?.referenceRange?.[0].low?.value).toBe(4);
    expect(a1c?.referenceRange?.[0].high?.value).toBe(5.6);
  });

  it("omits referenceRange entirely when no bounds are present", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        labResults: [
          {
            panel: null,
            analyte: "CRP",
            value: 2.1,
            unit: "mg/L",
            referenceLow: null,
            referenceHigh: null,
            takenAt: "2026-04-22T08:00:00.000Z",
            count: 1,
          },
        ],
      }),
      { insuranceNumber: "A123456780" },
      FIXED_NOW,
    );
    const crp = observationsOf(bundle).find((o) => o.code.text === "CRP");
    expect(crp).toBeDefined();
    expect(crp?.referenceRange).toBeUndefined();
  });

  it("emits no lab Observations when labResults is null", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({ labResults: null }),
      { insuranceNumber: "A123456780" },
      FIXED_NOW,
    );
    const labObs = observationsOf(bundle).filter((o) =>
      o.category?.some((c) =>
        c.coding?.some((code) => code.code === "laboratory"),
      ),
    );
    expect(labObs).toHaveLength(0);
  });
});
