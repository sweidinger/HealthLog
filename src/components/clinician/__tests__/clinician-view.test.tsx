/**
 * v1.11.0 (Epic C, C5) — clinician-view presentation.
 *
 * Asserts the load-bearing rendering properties: the fenced wellness card
 * carries the descriptive "not a clinical assessment / not a diagnosis"
 * disclaimer, the provenance header renders, and the view holds no app chrome.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ClinicianView } from "../clinician-view";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { DEFAULT_DOCTOR_REPORT_PREFS } from "@/lib/validations/doctor-report-prefs";
import type { DoctorReportData } from "@/lib/doctor-report-data";

function makeReport(
  overrides: Partial<DoctorReportData> = {},
): DoctorReportData {
  return {
    period: {
      days: 30,
      since: "2026-01-01",
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-31T00:00:00.000Z",
    },
    patient: {
      username: "tester",
      dateOfBirth: null,
      gender: null,
      heightCm: null,
    },
    practiceName: null,
    measurements: {},
    stats: {
      WEIGHT: { avg: 80, min: 78, max: 82, count: 12, latest: 79 },
    },
    glucoseStats: {},
    glucoseRanges: {},
    glucoseUnit: "mg/dL",
    bmi: 24.5,
    compliance: {},
    medications: [],
    wellnessScores: [
      {
        type: "RECOVERY_SCORE",
        latest: 72,
        avg: 68,
        min: 50,
        max: 90,
        count: 20,
        latestAt: "2026-01-30T00:00:00.000Z",
      },
    ],
    ...overrides,
  } as DoctorReportData;
}

function render(report: DoctorReportData) {
  const { t } = getServerTranslator("en");
  return renderToStaticMarkup(
    <ClinicianView
      t={(k, v) => t(k, v)}
      label="Cardiology clinic"
      expiresAt="2026-03-01T00:00:00.000Z"
      report={report}
      sections={{ ...DEFAULT_DOCTOR_REPORT_PREFS }}
    />,
  );
}

describe("<ClinicianView>", () => {
  it("renders the fenced wellness card with the descriptive disclaimer", () => {
    const html = render(makeReport());
    expect(html).toContain("Wellness scores");
    expect(html).toContain("not a clinical assessment");
    expect(html).toContain("not a diagnosis");
    expect(html).toContain("Recovery score");
  });

  it("renders the provenance header treating values as patient-reported", () => {
    const html = render(makeReport());
    expect(html).toContain("Shared health record");
    expect(html).toContain("patient-reported");
    expect(html).toContain("Cardiology clinic");
  });

  it("renders clinical vitals from the scoped report", () => {
    const html = render(makeReport());
    expect(html).toContain("Vital signs");
    // The measurement-type enum renders as its localised label, not the raw
    // enum string.
    expect(html).toContain("Body weight");
    expect(html).not.toContain("WEIGHT");
  });

  it("omits the wellness card when there are no scores", () => {
    const html = render(makeReport({ wellnessScores: [] }));
    expect(html).not.toContain("Wellness scores");
  });

  it("carries no app chrome (no nav / coach landmarks)", () => {
    const html = render(makeReport());
    expect(html).not.toContain('data-slot="sidebar"');
    expect(html).not.toContain("coach");
  });
});
