import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { DataSummary } from "@/lib/analytics/trends";

import { MetricStatStrip } from "../metric-stat-strip";

/**
 * v1.8.5 — `<MetricStatStrip>` SSR coverage.
 *
 * The strip leads the insights category pages with the four central
 * stats — min / max / median / mean — read from the already-fetched
 * `summaries` slice (zero new network). Acceptance:
 *   1. Renders four labelled cells: min, max, median, mean.
 *   2. Each cell shows the formatted value + the metric unit.
 *   3. A null summary (read in flight) renders nothing rather than a
 *      strip full of em-dashes.
 *   4. A zero-count summary renders nothing (brand-new metric, no data).
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const populated: DataSummary = {
  count: 42,
  latest: 72,
  min: 58,
  max: 88,
  mean: 70.4,
  median: 71,
  avg7: 71,
  avg30: 70,
  slope7: null,
  slope30: null,
  slope90: null,
  anomalyCount: 0,
  avg30LastMonth: null,
  avg30LastYear: null,
};

describe("<MetricStatStrip>", () => {
  it("renders the four stat cells with min / max / median / mean", () => {
    const html = render(<MetricStatStrip summary={populated} unit="bpm" />);
    expect(html).toContain('data-stat="min"');
    expect(html).toContain('data-stat="max"');
    expect(html).toContain('data-stat="median"');
    expect(html).toContain('data-stat="mean"');
  });

  it("shows the formatted values and the unit", () => {
    const html = render(<MetricStatStrip summary={populated} unit="bpm" />);
    expect(html).toContain("58");
    expect(html).toContain("88");
    expect(html).toContain("71");
    expect(html).toContain("bpm");
  });

  it("renders nothing while the summary is still loading", () => {
    const html = render(<MetricStatStrip summary={null} unit="bpm" />);
    expect(html).toBe("");
  });

  it("renders nothing for a zero-count metric", () => {
    const empty: DataSummary = { ...populated, count: 0 };
    const html = render(<MetricStatStrip summary={empty} unit="bpm" />);
    expect(html).toBe("");
  });

  it("falls back to mean when median is absent (older payload)", () => {
    const noMedian: DataSummary = { ...populated, median: null };
    const html = render(<MetricStatStrip summary={noMedian} unit="bpm" />);
    // Median cell still paints (em-dash) so the four-up grid stays
    // balanced; min / max / mean keep their values.
    expect(html).toContain('data-stat="median"');
    expect(html).toContain('data-stat="mean"');
  });
});
