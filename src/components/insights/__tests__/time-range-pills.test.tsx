import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { TimeRangePills } from "../time-range-pills";
import { ANALYTICS_RANGES } from "@/lib/analytics/range-delta";

/**
 * v1.9.0 QA (Design H1) — the range pills are a WAI-ARIA APG radiogroup, so
 * the group must be a SINGLE tab stop: only the checked radio carries
 * `tabIndex={0}`, every other radio is `-1` (roving tabindex). Before the
 * fix all four were native buttons (four tab stops) with no arrow-key
 * handler. Project convention is SSR-only tests, so we assert the rendered
 * roving-tabindex contract + radio semantics rather than driving live key
 * events.
 */
function render(value: (typeof ANALYTICS_RANGES)[number]) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <TimeRangePills value={value} onChange={() => {}} />
    </I18nProvider>,
  );
}

describe("TimeRangePills — roving tabindex (single tab stop)", () => {
  it("renders a radiogroup with one radio per range", () => {
    const html = render("30d");
    expect(html).toContain('role="radiogroup"');
    const radios = html.match(/role="radio"/g) ?? [];
    expect(radios).toHaveLength(ANALYTICS_RANGES.length);
  });

  it("makes only the checked radio tabbable (tabindex 0); the rest are -1", () => {
    const html = render("30d");
    // Exactly one tabindex=0 (the checked radio is the single tab stop).
    const tabbable = html.match(/tabindex="0"/g) ?? [];
    expect(tabbable).toHaveLength(1);
    // The remaining three are removed from the tab order.
    const untabbable = html.match(/tabindex="-1"/g) ?? [];
    expect(untabbable).toHaveLength(ANALYTICS_RANGES.length - 1);
  });

  it("marks the chosen value selected (aria-checked + data-selected)", () => {
    const html = render("90d");
    // Exactly one radio is checked / selected.
    expect(html.match(/aria-checked="true"/g) ?? []).toHaveLength(1);
    expect(html.match(/data-selected="true"/g) ?? []).toHaveLength(1);
    // The chosen pill is present and selected.
    expect(html).toMatch(/data-range="90d"/);
  });
});
