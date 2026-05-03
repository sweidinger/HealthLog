import { describe, it, expect } from "vitest";
import {
  buildDoctorReportPdfDocument,
  renderDoctorReportPdfBytes,
} from "../doctor-report-pdf-core";
import type { DoctorReportData } from "../doctor-report-data";
import { getServerTranslator } from "../i18n/server-translator";

const FIXED_NOW = new Date("2026-05-03T12:00:00.000Z");

function makeData(overrides?: Partial<DoctorReportData>): DoctorReportData {
  return {
    period: { days: 90, since: "2026-02-02T00:00:00.000Z" },
    patient: {
      username: "marc",
      dateOfBirth: "1985-06-15T00:00:00.000Z",
      gender: "MALE",
      heightCm: 182,
    },
    measurements: {
      WEIGHT: [
        { value: 80, measuredAt: "2026-02-10T08:00:00.000Z" },
        { value: 79.5, measuredAt: "2026-04-30T08:00:00.000Z" },
      ],
    },
    stats: {
      WEIGHT: { avg: 79.75, min: 79.5, max: 80, count: 2, latest: 79.5 },
      BLOOD_PRESSURE_SYS: {
        avg: 122,
        min: 118,
        max: 128,
        count: 5,
        latest: 120,
      },
      BLOOD_PRESSURE_DIA: {
        avg: 78,
        min: 72,
        max: 82,
        count: 5,
        latest: 78,
      },
      PULSE: { avg: 65, min: 58, max: 72, count: 5, latest: 64 },
    },
    glucoseStats: {
      FASTING: { avg: 92, min: 85, max: 100, count: 4, latest: 90 },
    },
    glucoseRanges: { FASTING: { min: 70, max: 99 } },
    glucoseUnit: "mg/dL",
    bmi: 24.1,
    compliance: {
      Ramipril: { total: 90, taken: 85, skipped: 3, missed: 2 },
    },
    medications: [
      {
        name: "Ramipril",
        dose: "5mg",
        schedules: [
          { windowStart: "08:00", windowEnd: "09:00", label: "Morning" },
        ],
      },
    ],
    mood: {
      avg: 3.6,
      min: 2,
      max: 5,
      count: 30,
      distribution: { 1: 0, 2: 3, 3: 9, 4: 14, 5: 4 },
    },
    ...overrides,
  };
}

describe("renderDoctorReportPdfBytes", () => {
  it("returns a Uint8Array starting with the %PDF- header", () => {
    const { t } = getServerTranslator("de");
    const bytes = renderDoctorReportPdfBytes(makeData(), {
      t,
      locale: "de",
      now: FIXED_NOW,
    });
    expect(bytes).toBeInstanceOf(Uint8Array);
    const header = String.fromCharCode(...bytes.slice(0, 5));
    expect(header).toBe("%PDF-");
  });

  it("produces a non-trivial document (> 1 KB)", () => {
    const { t } = getServerTranslator("de");
    const bytes = renderDoctorReportPdfBytes(makeData(), {
      t,
      locale: "de",
      now: FIXED_NOW,
    });
    expect(bytes.byteLength).toBeGreaterThan(1024);
  });

  it("is structurally deterministic for the same input + fixed timestamp", () => {
    // jsPDF embeds a per-invocation file-id in the trailer (random UUID-like
    // hex). The visible content is fully determined by the inputs, so we
    // assert byte-length equality + identical content sections instead of a
    // strict bytewise compare.
    const { t } = getServerTranslator("de");
    const a = renderDoctorReportPdfBytes(makeData(), {
      t,
      locale: "de",
      now: FIXED_NOW,
    });
    const b = renderDoctorReportPdfBytes(makeData(), {
      t,
      locale: "de",
      now: FIXED_NOW,
    });
    expect(a.byteLength).toBe(b.byteLength);
    // Compare the first 95% of the document — file-id and trailer differ.
    const cmp = Math.floor(a.byteLength * 0.95);
    expect(
      Buffer.from(a.slice(0, cmp)).equals(Buffer.from(b.slice(0, cmp))),
    ).toBe(true);
  });

  it("renders both DE and EN locales without errors", () => {
    const de = renderDoctorReportPdfBytes(makeData(), {
      t: getServerTranslator("de").t,
      locale: "de",
      now: FIXED_NOW,
    });
    const en = renderDoctorReportPdfBytes(makeData(), {
      t: getServerTranslator("en").t,
      locale: "en",
      now: FIXED_NOW,
    });
    expect(de.byteLength).toBeGreaterThan(1024);
    expect(en.byteLength).toBeGreaterThan(1024);
  });

  it("handles empty stats / no mood without throwing", () => {
    const empty = makeData({
      stats: {},
      glucoseStats: {},
      glucoseRanges: {},
      compliance: {},
      mood: null,
      bmi: null,
    });
    const bytes = renderDoctorReportPdfBytes(empty, {
      t: getServerTranslator("de").t,
      locale: "de",
      now: FIXED_NOW,
    });
    const header = String.fromCharCode(...bytes.slice(0, 5));
    expect(header).toBe("%PDF-");
  });
});

describe("buildDoctorReportPdfDocument", () => {
  it("returns a jsPDF doc with at least one page", () => {
    const doc = buildDoctorReportPdfDocument(makeData(), {
      t: getServerTranslator("de").t,
      locale: "de",
      now: FIXED_NOW,
    });
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
  });
});
