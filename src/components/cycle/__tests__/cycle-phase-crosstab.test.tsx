import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CyclePhaseCrosstab,
  CyclePhaseHeadline,
  type CyclePhaseCrosstabRow,
  type CyclePhaseCrosstabDisplay,
} from "../cycle-phase-crosstab";
import { I18nProvider } from "@/lib/i18n/context";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

function row(
  metricKey: string,
  display: CyclePhaseCrosstabDisplay,
): CyclePhaseCrosstabRow {
  return {
    metricKey,
    display,
    lutealDays: 12,
    follicularDays: 11,
    lutealAvg: 5,
    follicularAvg: 4,
    delta: 1,
    pValue: 0.01,
    qValue: 0.02,
    confidence: "high",
  };
}

describe("<CyclePhaseCrosstab>", () => {
  // Regression: the server emits `display: "mood"` and `display: "glucose"`,
  // which the client UNIT_KEY map did not cover. The map miss handed `undefined`
  // to `t()`, whose resolver runs `key.split(".")` → "Cannot read properties of
  // undefined (reading 'split')", crashing the whole insights tab.
  it("renders mood and glucose rows without throwing", () => {
    expect(() =>
      render(
        <CyclePhaseCrosstab
          rows={[row("mood", "mood"), row("bloodGlucose", "glucose")]}
        />,
      ),
    ).not.toThrow();
  });

  it("resolves the mood + glucose metric labels and units", () => {
    const html = render(
      <CyclePhaseCrosstab
        rows={[row("mood", "mood"), row("bloodGlucose", "glucose")]}
      />,
    );
    expect(html).toContain("Mood");
    expect(html).toContain("Blood glucose");
    expect(html).toContain("pts");
    expect(html).toContain("mg/dL");
    // Never leaks the raw metric key or the raw i18n key on a covered row.
    expect(html).not.toContain("cycle.insights.crosstab");
  });

  it("renders the headline for a mood row without throwing", () => {
    expect(() =>
      render(<CyclePhaseHeadline headline={row("mood", "mood")} />),
    ).not.toThrow();
  });

  it("degrades an unknown display to an empty unit instead of crashing", () => {
    const unknown = row(
      "somethingNew",
      "unmappedDisplay" as unknown as CyclePhaseCrosstabDisplay,
    );
    expect(() => render(<CyclePhaseCrosstab rows={[unknown]} />)).not.toThrow();
    expect(() =>
      render(<CyclePhaseHeadline headline={unknown} />),
    ).not.toThrow();
    // The delta still renders; the unit segment is simply blank (trailing space
    // trimmed away in markup), never the literal "undefined".
    const html = render(<CyclePhaseCrosstab rows={[unknown]} />);
    expect(html).not.toContain("undefined");
  });
});
