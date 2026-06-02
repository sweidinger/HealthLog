import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Heart } from "lucide-react";

import { SparklineDeltaTile } from "../sparkline-delta-tile";
import { I18nProvider } from "@/lib/i18n/context";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const base = {
  label: "Resting HR",
  unit: "bpm",
  icon: Heart,
};

describe("<SparklineDeltaTile>", () => {
  it("renders the value, unit and a framing line (populated)", () => {
    const html = render(
      <SparklineDeltaTile
        {...base}
        value={58}
        series={[60, 59, 58, 57, 58]}
        delta={-3}
        directionSentiment="up-bad"
        framing="typical for age 31"
      />,
    );
    expect(html).toContain('data-slot="sparkline-delta-tile"');
    expect(html).toContain('data-slot="sparkline-delta-tile-value"');
    expect(html).toContain("58");
    expect(html).toContain("bpm");
    expect(html).toContain("typical for age 31");
    expect(html).toContain('data-slot="sparkline-delta-tile-framing"');
  });

  it("paints a falling delta on an up-bad metric as green (improvement)", () => {
    const html = render(
      <SparklineDeltaTile
        {...base}
        value={58}
        delta={-3}
        directionSentiment="up-bad"
      />,
    );
    expect(html).toContain('data-slot="sparkline-delta-tile-delta"');
    expect(html).toContain("text-dracula-green");
  });

  it("renders the empty state for a null value (no value, dashed sparkline slot)", () => {
    const html = render(<SparklineDeltaTile {...base} value={null} />);
    expect(html).toContain('data-slot="sparkline-delta-tile-value"');
    expect(html).toContain("—");
    // No series → dashed placeholder, not an SVG.
    expect(html).toContain("border-dashed");
  });

  it("reserves the sparkline slot but omits the chart when series < 2 points", () => {
    const html = render(
      <SparklineDeltaTile {...base} value={58} series={[58]} />,
    );
    expect(html).toContain('data-slot="sparkline-delta-tile-spark"');
    expect(html).toContain("border-dashed");
  });

  it("surfaces the stale caption when staleDays > 7", () => {
    const html = render(
      <SparklineDeltaTile {...base} value={58} staleDays={12} />,
    );
    expect(html).toContain('data-slot="sparkline-delta-tile-stale"');
    expect(html).toContain('data-stale-days="12"');
  });

  it("omits the stale caption for fresh data", () => {
    const html = render(
      <SparklineDeltaTile {...base} value={58} staleDays={3} />,
    );
    expect(html).not.toContain('data-slot="sparkline-delta-tile-stale"');
  });
});
