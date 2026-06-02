import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { DerivedMetricResponse } from "../use-derived-metric";

// Drive the grid by stubbing the per-tile query hook; each tile renders the
// state the mock returns for its (metric, type) pair.
const useDerivedMetric = vi.fn();
vi.mock("../use-derived-metric", () => ({
  useDerivedMetric: (...a: unknown[]) => useDerivedMetric(...a),
}));

import { VitalsDashboard } from "../vitals-dashboard";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

type Resp = DerivedMetricResponse<Record<string, unknown>>;

function ok(value: Record<string, unknown>): { data: Resp; isLoading: false } {
  return {
    isLoading: false,
    data: {
      metric: "X",
      status: "ok",
      value,
      coverage: { requiredInputs: 1, presentInputs: 1, historyDays: 30, missing: [] },
      confidence: { score: 90, band: "high" },
      provenance: { inputs: [], source: "DAY", windowDays: 30, computedAt: "x" },
      reason: null,
    },
  };
}
function insufficient(reason: string, historyDays = 0): { data: Resp; isLoading: false } {
  return {
    isLoading: false,
    data: {
      metric: "X",
      status: "insufficient",
      value: null,
      coverage: { requiredInputs: 1, presentInputs: reason === "no_readings_in_window" ? 0 : 1, historyDays, missing: [] },
      confidence: null,
      provenance: { inputs: [], source: "none", windowDays: 30, computedAt: "x" },
      reason,
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("<VitalsDashboard>", () => {
  it("renders an available baseline vital as an ok tile", () => {
    useDerivedMetric.mockImplementation((metric: string, opts?: { type?: string }) => {
      if (metric === "VITALS_BASELINE" && opts?.type === "RESTING_HEART_RATE") {
        return ok({ type: "RESTING_HEART_RATE", center: 55, low: 48, high: 62, spread: 7, sampleDays: 30, k: 3 });
      }
      return insufficient("no_readings_in_window");
    });
    const html = render(<VitalsDashboard />);
    expect(html).toContain('data-slot="vitals-dashboard"');
    expect(html).toContain('data-metric="RESTING_HEART_RATE"');
    expect(html).toContain('data-state="ok"');
    // Typical-range framing rendered.
    expect(html).toContain("Typical for you");
  });

  it("hides an absent vital entirely (no tile)", () => {
    useDerivedMetric.mockReturnValue(insufficient("no_readings_in_window"));
    const html = render(<VitalsDashboard />);
    // The grid + heading still render, but no value tile.
    expect(html).toContain('data-slot="vitals-dashboard-grid"');
    expect(html).not.toContain('data-state="ok"');
    expect(html).not.toContain('data-metric="WEIGHT"');
  });

  it("shows a provisional baseline tile with the coverage meter, not a headline", () => {
    useDerivedMetric.mockImplementation((metric: string, opts?: { type?: string }) => {
      if (metric === "VITALS_BASELINE" && opts?.type === "WEIGHT") {
        return insufficient("insufficient_history_for_band", 4);
      }
      return insufficient("no_readings_in_window");
    });
    const html = render(<VitalsDashboard />);
    expect(html).toContain('data-metric="WEIGHT"');
    expect(html).toContain('data-state="provisional"');
    expect(html).toContain('data-slot="coverage-meter"');
    expect(html).toContain("Building your typical range");
  });

  it("renders the fitness-age tile with its age framing", () => {
    useDerivedMetric.mockImplementation((metric: string) => {
      if (metric === "FITNESS_AGE") {
        return ok({ vo2Max: 46, band: "green", fitnessAgeDeltaYears: -6, referenceBand: { low: 35, high: 45 }, trendDelta: 2, readingCount: 4 });
      }
      return insufficient("no_readings_in_window");
    });
    const html = render(<VitalsDashboard />);
    expect(html).toContain('data-metric="FITNESS_AGE"');
    expect(html).toContain("yr younger");
  });

  it("renders the BMI tile with its WHO category", () => {
    useDerivedMetric.mockImplementation((metric: string) => {
      if (metric === "BMI") {
        return ok({ bmi: 24.7, category: "normal", band: "green", weightKg: 80, heightCm: 180 });
      }
      return insufficient("no_readings_in_window");
    });
    const html = render(<VitalsDashboard />);
    expect(html).toContain('data-metric="BMI"');
    expect(html).toContain("Normal range (WHO)");
  });

  it("hides BMI when there is no height/weight", () => {
    useDerivedMetric.mockImplementation((metric: string) => {
      if (metric === "BMI") return insufficient("no_height_on_profile");
      return insufficient("no_readings_in_window");
    });
    const html = render(<VitalsDashboard />);
    expect(html).not.toContain('data-metric="BMI"');
  });
});
