import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import type { InsightStatusData } from "@/hooks/use-insight-status";

/**
 * v1.8.7.1 — `<HealthKitMetricPage statusMetric=…>` mounts the generic
 * per-metric assessment card beneath the chart when the metric has data,
 * and falls back to the existing insufficient-data empty state otherwise.
 *
 * The page leans on several hooks (`useAuth`, `useInsightsAnalytics`,
 * `useInsightMetricStatus`, …); the test mocks them so the data /
 * empty branch is deterministic. The chart is `next/dynamic`-imported,
 * so SSR renders its stub — enough to verify the assessment slot.
 */

vi.mock("next/dynamic", () => ({
  default: () => {
    const Stub = () => <div data-slot="healthkit-chart-stub" />;
    Stub.displayName = "HealthChartStub";
    return Stub;
  },
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { timezone: "UTC", dateOfBirth: null, gender: null },
    isAuthenticated: true,
  }),
}));

vi.mock("@/hooks/use-insights-layout-prefs", () => ({
  useInsightsLayoutPrefs: () => ({ layout: null, compareBaseline: false }),
}));

const analyticsMock = vi.fn();
vi.mock("@/hooks/use-insights-analytics", () => ({
  useInsightsAnalytics: () => analyticsMock(),
}));

const metricStatusMock = vi.fn();
vi.mock("@/hooks/use-insight-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-insight-status")>();
  return {
    ...actual,
    useInsightMetricStatus: (...args: unknown[]) => metricStatusMock(...args),
  };
});

import { HealthKitMetricPage } from "../healthkit-metric-page";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale={locale}>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

const baseProps = {
  measurementType: "HEART_RATE_VARIABILITY",
  insightMetric: "HEART_RATE_VARIABILITY" as const,
  chartKey: "hrv" as const,
  i18nPrefix: "insights.hrv",
  color: "#bd93f9",
  unit: "ms",
  emptyStateIcon: null,
};

const settledStatus: InsightStatusData = {
  hasProvider: true,
  text: "Your HRV has trended upward over the last month.",
  cached: false,
  updatedAt: null,
};

beforeEach(() => {
  analyticsMock.mockReset();
  metricStatusMock.mockReset();
});

describe("<HealthKitMetricPage> status mount", () => {
  it("mounts the assessment card when statusMetric is set and the metric has data", () => {
    analyticsMock.mockReturnValue({
      data: { summaries: { HEART_RATE_VARIABILITY: { count: 12 } } },
      isEmpty: false,
    });
    metricStatusMock.mockReturnValue({
      data: settledStatus,
      isLoading: false,
    });

    const html = render(
      <HealthKitMetricPage
        {...baseProps}
        statusMetric="HEART_RATE_VARIABILITY"
      />,
    );

    expect(html).toContain("Your HRV has trended upward");
    // The card fetch is enabled (statusMetric present + data present).
    expect(metricStatusMock).toHaveBeenCalledWith("HEART_RATE_VARIABILITY", true);
  });

  it("does not mount the assessment card when statusMetric is omitted", () => {
    analyticsMock.mockReturnValue({
      data: { summaries: { HEART_RATE_VARIABILITY: { count: 12 } } },
      isEmpty: false,
    });
    metricStatusMock.mockReturnValue({ data: undefined, isLoading: false });

    const html = render(<HealthKitMetricPage {...baseProps} />);

    // No assessment heading, and the generic fetch is disabled.
    expect(html).not.toContain("Assessment");
    expect(metricStatusMock).toHaveBeenCalledWith("", false);
  });

  it("renders the insufficient-data empty state (no card) when the metric has no data", () => {
    analyticsMock.mockReturnValue({ data: null, isEmpty: true });
    metricStatusMock.mockReturnValue({ data: undefined, isLoading: false });

    const html = render(
      <HealthKitMetricPage
        {...baseProps}
        statusMetric="HEART_RATE_VARIABILITY"
      />,
    );

    // Empty branch: no settled assessment text, and the status fetch is
    // disabled so a source-less account never fires the round-trip.
    expect(html).not.toContain("Your HRV has trended upward");
    expect(metricStatusMock).toHaveBeenCalledWith("HEART_RATE_VARIABILITY", false);
  });
});
