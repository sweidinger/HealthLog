import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { MetricRangeDelta } from "../metric-range-delta";
import type { AnalyticsRangeData } from "@/hooks/use-analytics-range";

/**
 * v1.9.0 QA (Design M1 / Correctness L-1) — a perfectly stable metric
 * (delta === 0 / rounded 0 %) must read neutral: a flat dash and "no
 * change", never a down-arrow with "−0%".
 */
function render(data: AnalyticsRangeData | undefined) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MetricRangeDelta
        data={data}
        range="30d"
        directionSentiment="up-good"
        isLoading={false}
      />
    </I18nProvider>,
  );
}

const base: AnalyticsRangeData = {
  range: "30d",
  windowDays: 30,
  granularity: "DAY",
  current: { count: 1, min: 1, max: 1, mean: 1, sum: 1 },
  previous: { count: 1, min: 1, max: 1, mean: 1, sum: 1 },
  delta: 0,
  deltaPct: 0,
};

describe("MetricRangeDelta — zero-delta neutral", () => {
  it("renders neutral copy + no directional arrow for a zero delta", () => {
    const html = render(base);
    expect(html).toContain('data-direction="neutral"');
    expect(html).toContain("no change");
    // No misleading "−0%".
    expect(html).not.toContain("0%");
    expect(html).not.toContain("−");
  });

  it("still renders a directional +pct for a real increase", () => {
    const html = render({ ...base, delta: 2, deltaPct: 0.1 });
    expect(html).toContain('data-direction=');
    expect(html).not.toContain('data-direction="neutral"');
    expect(html).toContain("+10%");
  });

  it("shows the no-prior-data line when the comparison is null", () => {
    const html = render({ ...base, delta: null, deltaPct: null });
    expect(html).toContain("metric-range-delta-empty");
  });
});
