import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.32.1 (issue #584) — `/insights/pulse` must chart the metric its own
 * title, capture action, and stat strip claim. `hasRestingHr` used to swap
 * the ENTIRE primary chart + Coach read strip to RESTING_HEART_RATE the
 * moment any resting-HR row existed, so the page could show a resting-only
 * series while every other surface (title, stat strip, capture action,
 * "show all values") stayed labelled "Pulse" — a silent full swap.
 * RESTING_HEART_RATE may now appear only as a second, clearly-labelled
 * series alongside PULSE (the same multi-series pattern the blood-pressure
 * page uses for systolic/diastolic) — never a swap.
 *
 * `SubPageShell` is stubbed to a probe recording its props (including the
 * `children` array holding the chart element) so these assert the resolved
 * chart/coach-strip props rather than rendered text — responsive classes
 * have broken text-based queries in this repo.
 */

const shellProps = vi.fn();
vi.mock("@/components/insights/sub-page-shell", () => ({
  SubPageShell: (props: Record<string, unknown>) => {
    shellProps(props);
    return null;
  },
}));

vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: { dateOfBirth: null, gender: null, timezone: "UTC" },
  }),
}));

const analytics = {
  current: { summaries: {} as Record<string, { count: number }> },
};
vi.mock("@/hooks/use-insights-analytics", () => ({
  useInsightsAnalytics: () => ({
    data: analytics.current,
    isLoading: false,
    isEmpty: false,
    error: null,
    refetch: () => {},
  }),
}));

// `useInsightsLayoutPrefs` is the one real hook left that reaches
// `@tanstack/react-query`; stub `useQuery` so the page renders without a
// `QueryClientProvider` ancestor (mirrors the coach-page-launch-params test).
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isLoading: false, error: null }),
}));

import InsightsPulsPage from "../page";

interface CapturedShellProps {
  captureType?: string;
  showAllValuesType?: string;
  coachReadStrip?: { props?: Record<string, unknown> };
  children?: unknown;
}

function renderPage(
  summaries: Record<string, { count: number }>,
): CapturedShellProps {
  analytics.current = { summaries };
  renderToStaticMarkup(<InsightsPulsPage />);
  const calls = shellProps.mock.calls;
  return calls[calls.length - 1][0] as CapturedShellProps;
}

/** Locate the primary `<HealthChartDynamic>` element among the page's
 *  children by its distinctive `types` array prop. Never rendered — the
 *  `SubPageShell` stub does not paint `children` — so this reads the plain
 *  React element object the page constructed. */
function findChartElement(
  children: unknown,
): { props: { types?: string[] } } | undefined {
  const arr = Array.isArray(children) ? children : [children];
  return arr.find(
    (el): el is { props: { types?: string[] } } =>
      Boolean(el) &&
      typeof el === "object" &&
      el !== null &&
      "props" in el &&
      Array.isArray((el as { props?: { types?: unknown } }).props?.types),
  );
}

describe("/insights/pulse page — chart identity (issue #584)", () => {
  beforeEach(() => {
    shellProps.mockClear();
  });

  it("charts PULSE as the primary (first) series even when resting-HR data exists", () => {
    const props = renderPage({
      PULSE: { count: 50 },
      RESTING_HEART_RATE: { count: 30 },
    });
    const chart = findChartElement(props.children);
    expect(chart).toBeDefined();
    expect(chart!.props.types).toEqual(["PULSE", "RESTING_HEART_RATE"]);
  });

  it("never swaps the chart to a RESTING_HEART_RATE-only series", () => {
    const props = renderPage({
      PULSE: { count: 50 },
      RESTING_HEART_RATE: { count: 30 },
    });
    const chart = findChartElement(props.children);
    expect(chart!.props.types).not.toEqual(["RESTING_HEART_RATE"]);
  });

  it("charts PULSE alone when there is no resting-HR data", () => {
    const props = renderPage({ PULSE: { count: 50 } });
    const chart = findChartElement(props.children);
    expect(chart!.props.types).toEqual(["PULSE"]);
  });

  it("keeps the Coach read strip pinned to PULSE regardless of resting-HR data", () => {
    const props = renderPage({
      PULSE: { count: 50 },
      RESTING_HEART_RATE: { count: 30 },
    });
    expect(props.coachReadStrip?.props?.metricType).toBe("PULSE");
  });

  it("keeps captureType and showAllValuesType pinned to PULSE", () => {
    const props = renderPage({
      PULSE: { count: 50 },
      RESTING_HEART_RATE: { count: 30 },
    });
    expect(props.captureType).toBe("PULSE");
    expect(props.showAllValuesType).toBe("PULSE");
  });
});
