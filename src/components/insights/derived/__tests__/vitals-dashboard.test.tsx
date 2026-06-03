import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type {
  DerivedMetricResponse,
  DerivedBatchToken,
} from "../use-derived-metric";

// The dashboard now reads the whole grid through ONE batched query. Drive it
// by stubbing `useDerivedBatch` and returning a `read(token)` selector that
// resolves each (metric, type) pair from a scenario map.
const useDerivedBatch = vi.fn();
vi.mock("../use-derived-metric", () => ({
  useDerivedBatch: (...a: unknown[]) => useDerivedBatch(...a),
}));
// The auth hook gates the (mocked-away) query — stub it authenticated.
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));

import { VitalsDashboard } from "../vitals-dashboard";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

type Resp = DerivedMetricResponse<Record<string, unknown>>;

function ok(value: Record<string, unknown>): Resp {
  return {
    metric: "X",
    status: "ok",
    value,
    coverage: { requiredInputs: 1, presentInputs: 1, historyDays: 30, missing: [] },
    confidence: { score: 90, band: "high" },
    provenance: { inputs: [], source: "DAY", windowDays: 30, computedAt: "x" },
    reason: null,
  };
}
function insufficient(reason: string, historyDays = 0): Resp {
  return {
    metric: "X",
    status: "insufficient",
    value: null,
    coverage: {
      requiredInputs: 1,
      presentInputs: reason === "no_readings_in_window" ? 0 : 1,
      historyDays,
      missing: [],
    },
    confidence: null,
    provenance: { inputs: [], source: "none", windowDays: 30, computedAt: "x" },
    reason,
  };
}

/**
 * Install a batch mock that resolves each requested token from `resolve`,
 * defaulting unmatched tokens to the absent state so a scenario only has to
 * name the tiles it cares about.
 */
function mockBatch(
  resolve: (token: DerivedBatchToken) => Resp,
  extra: { isLoading?: boolean; isError?: boolean; refetch?: () => void } = {},
) {
  useDerivedBatch.mockReturnValue({
    isLoading: extra.isLoading ?? false,
    isError: extra.isError ?? false,
    refetch: extra.refetch ?? (() => {}),
    read: <T,>(token: DerivedBatchToken) => resolve(token) as unknown as DerivedMetricResponse<T>,
  });
}

beforeEach(() => vi.clearAllMocks());

describe("<VitalsDashboard>", () => {
  it("renders an available baseline vital as an ok tile", () => {
    mockBatch((token) => {
      if (token.metric === "VITALS_BASELINE" && token.type === "RESTING_HEART_RATE") {
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

  it("hides the whole section (heading + grid) when no vital has content", () => {
    mockBatch(() => insufficient("no_readings_in_window"));
    const html = render(<VitalsDashboard />);
    // No content under the heading → the heading must not strand over blank
    // space. The whole section un-mounts.
    expect(html).not.toContain('data-slot="vitals-dashboard"');
    expect(html).not.toContain('data-slot="vitals-dashboard-grid"');
    expect(html).not.toContain("Your vitals");
    expect(html).not.toContain('data-state="ok"');
  });

  it("renders a skeleton row (no tiles, no heading strand) while loading", () => {
    mockBatch(() => insufficient("no_readings_in_window"), { isLoading: true });
    const html = render(<VitalsDashboard />);
    // Heading + grid present so the section reserves its final height, with a
    // busy/live region and skeleton placeholders — but no real tiles yet.
    expect(html).toContain('data-slot="vitals-dashboard"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-slot="vitals-tile-skeleton"');
    expect(html).not.toContain('data-slot="vitals-tile"');
  });

  it("shows an inline error + retry when the batch fails", () => {
    mockBatch(() => insufficient("no_readings_in_window"), { isError: true });
    const html = render(<VitalsDashboard />);
    // The surface must not silently vanish — a compact error + a Retry button.
    expect(html).toContain('data-slot="vitals-dashboard-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-slot="vitals-dashboard-retry"');
    expect(html).toContain("Could not load your vitals");
    expect(html).toContain("Retry");
  });

  it("shows a provisional baseline tile with the coverage meter, not a headline", () => {
    mockBatch((token) => {
      if (token.metric === "VITALS_BASELINE" && token.type === "WEIGHT") {
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
    mockBatch((token) => {
      if (token.metric === "FITNESS_AGE") {
        return ok({ vo2Max: 46, band: "green", fitnessAgeDeltaYears: -6, referenceBand: { low: 35, high: 45 }, trendDelta: 2, readingCount: 4 });
      }
      return insufficient("no_readings_in_window");
    });
    const html = render(<VitalsDashboard />);
    expect(html).toContain('data-metric="FITNESS_AGE"');
    expect(html).toContain("yr younger");
  });

  it("renders the BMI tile with its WHO category", () => {
    mockBatch((token) => {
      if (token.metric === "BMI") {
        return ok({ bmi: 24.7, category: "normal", band: "green", weightKg: 80, heightCm: 180 });
      }
      return insufficient("no_readings_in_window");
    });
    const html = render(<VitalsDashboard />);
    expect(html).toContain('data-metric="BMI"');
    expect(html).toContain("Normal range (WHO)");
  });

  it("hides BMI when there is no height/weight", () => {
    mockBatch((token) => {
      if (token.metric === "BMI") return insufficient("no_height_on_profile");
      return insufficient("no_readings_in_window");
    });
    const html = render(<VitalsDashboard />);
    expect(html).not.toContain('data-metric="BMI"');
  });

  it("surfaces the coincident-deviation flag when it fired", () => {
    mockBatch((token) => {
      if (token.metric === "COINCIDENT_DEVIATION") {
        return ok({
          fired: true,
          day: "2026-06-02",
          vitals: [],
          contributing: [
            { type: "RESTING_HEART_RATE", value: 70, center: 55, low: 48, high: 62, outside: true, direction: "above" },
            { type: "RESPIRATORY_RATE", value: 20, center: 14, low: 12, high: 16, outside: true, direction: "above" },
          ],
        });
      }
      return insufficient("no_readings_in_window");
    });
    const html = render(<VitalsDashboard />);
    expect(html).toContain('data-metric="COINCIDENT_DEVIATION"');
    expect(html).toContain('data-state="fired"');
    // The provenance affordance reaches the flag.
    expect(html).toContain('data-slot="provenance-explainer-trigger"');
  });

  it("hides the coincident-deviation flag when it did not fire", () => {
    mockBatch((token) => {
      if (token.metric === "COINCIDENT_DEVIATION") {
        return ok({ fired: false, day: "2026-06-02", vitals: [], contributing: [] });
      }
      return insufficient("no_readings_in_window");
    });
    const html = render(<VitalsDashboard />);
    expect(html).not.toContain('data-metric="COINCIDENT_DEVIATION"');
  });
});
