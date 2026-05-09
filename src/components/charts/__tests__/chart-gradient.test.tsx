import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ChartLinearGradient,
  chartGradientFill,
} from "../chart-gradient";

/**
 * v1.4.16 B1a — pin the contract for the gradient primitive that every
 * chart wrapper now consumes:
 *
 *   - emits an SVG `<defs><linearGradient>` block with the requested id,
 *   - top stop carries the metric colour at ~35 % alpha by default,
 *   - bottom stop fades to 0 %,
 *   - the helper `chartGradientFill()` builds the matching `url(#id)`
 *     reference Recharts expects on `<Area fill=...>`.
 */

describe("<ChartLinearGradient>", () => {
  it("renders a vertical linearGradient with the supplied id and colour token", () => {
    // Wrap in <svg> because <defs> outside an SVG triggers a React
    // hydration warning under jsdom; here we render to static markup so
    // the wrapper just keeps the output well-formed.
    const html = renderToStaticMarkup(
      <svg>
        <ChartLinearGradient id="bp-gradient" colorVar="--dracula-purple" />
      </svg>,
    );

    expect(html).toContain('id="bp-gradient"');
    // Vertical gradient — top to bottom.
    expect(html).toContain('x1="0"');
    expect(html).toContain('y1="0"');
    expect(html).toContain('y2="1"');
    // The colour token round-trips into a `var(...)` reference.
    expect(html).toContain("var(--dracula-purple)");
    // Default opacity: 0.35 at top, 0 at bottom.
    expect(html).toContain('stop-opacity="0.35"');
    expect(html).toContain('stop-opacity="0"');
    // Marker used by visual-regression / e2e smoke tests.
    expect(html).toContain('data-slot="chart-linear-gradient"');
    expect(html).toContain('data-color-var="--dracula-purple"');
  });

  it("respects custom topOpacity / bottomOpacity overrides", () => {
    const html = renderToStaticMarkup(
      <svg>
        <ChartLinearGradient
          id="weight-gradient"
          colorVar="--dracula-cyan"
          topOpacity={0.5}
          bottomOpacity={0.05}
        />
      </svg>,
    );
    expect(html).toContain('stop-opacity="0.5"');
    expect(html).toContain('stop-opacity="0.05"');
  });
});

describe("chartGradientFill()", () => {
  it("builds a Recharts-shaped url() reference", () => {
    expect(chartGradientFill("bp-gradient")).toBe("url(#bp-gradient)");
    expect(chartGradientFill("mood")).toBe("url(#mood)");
  });
});
