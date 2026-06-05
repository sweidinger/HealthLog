import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  MoodTagInfluence,
  type MoodTagInfluenceRow,
} from "../mood-tag-influence";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

function flatRow(over: Partial<MoodTagInfluenceRow> = {}): MoodTagInfluenceRow {
  return {
    tag: "exercise",
    labelKey: null,
    categoryKey: null,
    icon: null,
    withDays: 14,
    withoutDays: 14,
    withAvg: 4.5,
    withoutAvg: 2.5,
    delta: 2,
    pValue: 0.001,
    confidence: "high",
    ...over,
  };
}

describe("<MoodTagInfluence>", () => {
  it("renders nothing for an empty list", () => {
    expect(render(<MoodTagInfluence rows={[]} />)).toBe("");
  });

  it("shows a flat tag verbatim with a signed delta and confidence chip", () => {
    const html = render(<MoodTagInfluence rows={[flatRow()]} />);
    expect(html).toContain("exercise");
    expect(html).toContain("+2.0");
    expect(html).toContain("High confidence");
    // with/without detail uses the real averages + present-day count
    expect(html).toContain("4.5");
    expect(html).toContain("2.5");
    expect(html).toContain("14");
    expect(html).toContain('data-slot="mood-tag-influence"');
    expect(html).toContain('data-direction="up"');
  });

  it("renders a negative delta as a down row without a plus sign", () => {
    const html = render(
      <MoodTagInfluence
        rows={[
          flatRow({ tag: "poor_sleep", delta: -1.4, confidence: "medium" }),
        ]}
      />,
    );
    expect(html).toContain("-1.4");
    expect(html).not.toContain("+-1.4");
    expect(html).toContain('data-direction="down"');
    expect(html).toContain("Medium confidence");
  });

  it("resolves a structured tag label key", () => {
    const html = render(
      <MoodTagInfluence
        rows={[
          flatRow({
            tag: "happy",
            labelKey: "charts.weekdaysFull.mon",
            categoryKey: "feelings",
            icon: "Smile",
          }),
        ]}
      />,
    );
    expect(html).toContain("Monday");
    expect(html).not.toContain("charts.weekdaysFull.mon");
  });

  it("does not render a local generic disclaimer", () => {
    const html = render(
      <MoodTagInfluence rows={[flatRow(), flatRow({ tag: "social" })]} />,
    );
    // The generic "associations, not causes" caveat now lives once in the
    // page-level Insights footer, not on this list.
    expect(html).not.toContain("not proof of cause");
  });
});
