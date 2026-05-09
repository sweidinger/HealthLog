import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ChartEmptyState } from "../chart-empty-state";

describe("<ChartEmptyState>", () => {
  it("renders the title and the line-chart glyph", () => {
    const html = renderToStaticMarkup(
      <ChartEmptyState title="Add more measurements to see trends" />,
    );
    expect(html).toContain("Add more measurements to see trends");
    // lucide-react LineChart emits an `<svg ...>` — the line-chart icon
    // is identifiable by its `class="lucide lucide-line-chart"` (or
    // similar) root class. We just assert one svg landed in the output.
    expect(html).toContain("<svg");
    expect(html).toContain('data-slot="chart-empty-state"');
  });

  it("renders an optional description below the title", () => {
    const html = renderToStaticMarkup(
      <ChartEmptyState
        title="Not enough mood data"
        description="Log at least 3 entries to unlock the trend line."
      />,
    );
    expect(html).toContain("Not enough mood data");
    expect(html).toContain(
      "Log at least 3 entries to unlock the trend line.",
    );
  });

  it("uses a custom height when supplied", () => {
    const html = renderToStaticMarkup(
      <ChartEmptyState title="..." height={320} />,
    );
    expect(html).toContain("height:320px");
  });
});
