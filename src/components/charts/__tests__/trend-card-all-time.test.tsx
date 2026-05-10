import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Target } from "lucide-react";

import { TrendCard } from "../trend-card";
import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.4.22 A2 — BD-Zielbereich tile feature parity.
 *
 * The BP-in-target tile now ships the same set of features every other
 * tile already has:
 *   - the optional `avgAllTime` sub-value renders next to `7d` and
 *     `30d` so the long-arc number stays visible after v1.4.22 A1
 *     re-anchored the headline to the last-30-day window.
 *   - the trend arrow + 7-day-trend chip use a synthesised slope from
 *     the difference between the 7-day and 30-day in-target shares.
 *   - the comparison overlay flows through the same `compareBaseline`
 *     / `compareDelta` props the dashboard wires for every other tile.
 *
 * Other tiles leave `avgAllTime` undefined so the third sub-row never
 * renders — pinned via the negative case at the bottom.
 */

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

const baseProps = {
  label: "BP in target",
  latest: 50,
  unit: "%",
  avg7: 55,
  avg30: 50,
  slope30: null,
  icon: Target,
  directionSentiment: "up-good" as const,
};

describe("<TrendCard> avgAllTime sub-value (v1.4.22 A2)", () => {
  it("renders the all-time label + value when `avgAllTime` is provided", () => {
    const html = render(<TrendCard {...baseProps} avgAllTime={11} />);
    // The slot is keyed via `data-slot` so callers can target it
    // without scraping translated copy.
    expect(html).toContain('data-slot="trend-card-all-time"');
    expect(html).toContain("All-time");
    // The headline (50 %) is the 30-day pct after v1.4.22 A1; the
    // all-time number lives in the third sub-row. Both must render
    // (the formatter emits a trailing `.0` for integer values via the
    // shared `useFormatters().number(_, 1)` contract — same shape as
    // every other tile uses).
    expect(html).toContain(">50.0<");
    expect(html).toContain(">11.0<");
  });

  it("paints the all-time value with the supplied color class", () => {
    const html = render(
      <TrendCard
        {...baseProps}
        avgAllTime={11}
        avgAllTimeColorClass="text-dracula-orange"
      />,
    );
    expect(html).toContain("text-dracula-orange");
  });

  it("renders a dash for a null `avgAllTime` (no data yet) instead of a literal 'null'", () => {
    const html = render(<TrendCard {...baseProps} avgAllTime={null} />);
    expect(html).toContain('data-slot="trend-card-all-time"');
    expect(html).toContain(">—<");
    expect(html).not.toContain("null");
  });

  it("does NOT render the all-time slot when `avgAllTime` is undefined (other tiles untouched)", () => {
    const html = render(<TrendCard {...baseProps} />);
    expect(html).not.toContain('data-slot="trend-card-all-time"');
  });

  it("ships the trend arrow when a synthetic slope is provided", () => {
    // Synthetic slope: 7d (55) above 30d (50) → up direction → green
    // arrow under the up-good sentiment.
    const html = render(
      <TrendCard
        {...baseProps}
        slope30={{ slope: 5 / 30, direction: "up", confidence: 1 }}
        avgAllTime={11}
      />,
    );
    expect(html).toContain("text-dracula-green");
  });

  it("ships the 7-day-trend chip when a delta is provided", () => {
    const html = render(
      <TrendCard
        {...baseProps}
        slope30={{ slope: 5 / 30, direction: "up", confidence: 1 }}
        trend7Delta={5}
        avgAllTime={11}
      />,
    );
    // The TrendCard renders the delta as e.g. `(+5.0)` next to `7d:`.
    expect(html).toMatch(/\(\+5\.0\)/);
  });

  it("ships the comparison overlay when comparison is active", () => {
    const html = render(
      <TrendCard
        {...baseProps}
        avgAllTime={11}
        compareBaseline="lastMonth"
        compareDelta={4}
      />,
    );
    expect(html).toContain('data-slot="tile-compare-delta"');
    expect(html).toContain("+4.0");
  });
});
