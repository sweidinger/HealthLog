import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  MoodBetterDays,
  type MoodBetterDayFactor,
} from "../mood-better-days";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

const tagFactor: MoodBetterDayFactor = {
  source: "tag",
  key: "exercise",
  labelKey: null,
  categoryKey: null,
  icon: null,
  direction: "up",
  n: 14,
  confidence: "high",
  effectSize: 1,
  delta: 2,
  r: null,
};

const metricFactor: MoodBetterDayFactor = {
  source: "metric",
  key: "sleep",
  labelKey: null,
  categoryKey: null,
  icon: null,
  direction: "up",
  n: 40,
  confidence: "medium",
  effectSize: 0.6,
  delta: null,
  r: 0.6,
};

describe("<MoodBetterDays>", () => {
  it("renders nothing for an empty board", () => {
    expect(render(<MoodBetterDays factors={[]} />)).toBe("");
  });

  it("shows a tag factor with its mood delta", () => {
    const html = render(<MoodBetterDays factors={[tagFactor]} />);
    expect(html).toContain("exercise");
    expect(html).toContain("+2.0");
    expect(html).toContain("High confidence");
    expect(html).toContain('data-source="tag"');
    expect(html).toContain('data-direction="up"');
  });

  it("shows a metric factor with its labelled name and r value", () => {
    const html = render(<MoodBetterDays factors={[metricFactor]} />);
    // sleep maps to the localized correlation title, not the raw key
    expect(html).toContain("Mood vs. sleep");
    expect(html).toContain("r 0.60");
    expect(html).toContain('data-source="metric"');
  });

  it("renders a down factor", () => {
    const html = render(
      <MoodBetterDays
        factors={[
          {
            ...metricFactor,
            key: "bloodPressureSystolic",
            direction: "down",
            r: -0.45,
          },
        ]}
      />,
    );
    expect(html).toContain('data-direction="down"');
    expect(html).toContain("r -0.45");
  });

  it("renders the description and disclaimer once each", () => {
    const html = render(
      <MoodBetterDays factors={[tagFactor, metricFactor]} />,
    );
    expect((html.match(/Associations only/g) ?? []).length).toBe(1);
    expect((html.match(/ranked by how strongly/g) ?? []).length).toBe(1);
    // one row per factor
    expect((html.match(/data-slot="mood-better-day-factor"/g) ?? []).length).toBe(
      2,
    );
  });
});
