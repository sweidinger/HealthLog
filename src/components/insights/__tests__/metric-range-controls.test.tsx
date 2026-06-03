import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.10.2 — `<MetricRangeControls>` is the shared range-controls block lifted
 * out of `<HealthKitMetricPage>` so the bespoke metric sub-pages render the
 * identical time-range pills + period-over-period delta. The component owns
 * the range pref + range read + direction-sentiment lookup; the test mocks
 * those hooks so the render stays deterministic and never touches `fetch`.
 */

const rangeMock = vi.fn();
vi.mock("@/hooks/use-insights-layout-prefs", () => ({
  useInsightsRangePref: () => ({ range: "30d", setRange: () => {} }),
}));

vi.mock("@/hooks/use-analytics-range", () => ({
  useAnalyticsRange: (...args: unknown[]) => rangeMock(...args),
}));

import { MetricRangeControls } from "../metric-range-controls";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

beforeEach(() => {
  rangeMock.mockReset();
  rangeMock.mockReturnValue({ data: undefined, isLoading: false });
});

describe("<MetricRangeControls>", () => {
  it("renders the time-range pills and the delta slot", () => {
    const html = render(<MetricRangeControls measurementType="WEIGHT" />);
    expect(html).toContain('data-slot="metric-range-controls"');
    expect(html).toContain('data-slot="time-range-pills"');
  });

  it("passes the measurement type and enabled flag through to the range read", () => {
    render(<MetricRangeControls measurementType="PULSE" enabled={false} />);
    expect(rangeMock).toHaveBeenCalledWith("PULSE", "30d", false);
  });

  it("defaults the range read to enabled", () => {
    render(<MetricRangeControls measurementType="SLEEP_DURATION" />);
    expect(rangeMock).toHaveBeenCalledWith("SLEEP_DURATION", "30d", true);
  });
});
