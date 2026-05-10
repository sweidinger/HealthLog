import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/context";
import type { CorrelationResult } from "@/lib/insights/correlations";

/**
 * v1.4.20 phase B3 — `<CorrelationRow>` layout + disclaimer.
 * v1.4.22 A4 update — empty-state cards are dropped instead of rendered.
 *
 * Acceptance:
 *   1. Renders only the hypothesis cards whose `status === "ok"`.
 *   2. Mounts the correlation-disclaimer footer once at the row level
 *      when at least one card renders; the row hides itself entirely
 *      when zero cards render (no header, no disclaimer).
 *   3. 2-up grid on >= md when 2+ cards, full-width single column when
 *      exactly 1 card renders.
 *   4. Below-threshold cards are filtered at the row level so the
 *      layout collapses cleanly.
 */

vi.mock("next/dynamic", () => ({
  default: () => {
    const Stub = () => <div data-slot="scatter-stub">scatter</div>;
    Stub.displayName = "ScatterStub";
    return Stub;
  },
}));

import { CorrelationRow } from "../correlation-row";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const okBpCompliance: CorrelationResult = {
  kind: "bp-compliance",
  status: "ok",
  statistic: -0.62,
  n: 28,
  pValue: 0.001,
  confidenceBand: { low: -0.85, high: -0.39, label: "high" },
  interpretation:
    "Higher medication compliance lines up with lower systolic — a pattern worth watching.",
  points: [{ x: 60, y: 140 }],
  xLabel: "Compliance %",
  yLabel: "Systolic (mmHg)",
};

const insufficientMoodPulse: CorrelationResult = {
  kind: "mood-pulse",
  status: "insufficient",
  n: 8,
  reason: "too_few_pairs",
  points: [],
};

const okWeightWeekday: CorrelationResult = {
  kind: "weight-weekday",
  status: "ok",
  statistic: 0.18,
  n: 28,
  pValue: 0.02,
  confidenceBand: { low: 0.18, high: 0.18, label: "moderate" },
  interpretation:
    "Monday weights run 0.6 kg above your other-day average — a pattern worth watching.",
  points: [{ x: 0, y: 84 }],
  xLabel: "Weekday",
  yLabel: "Weight (kg)",
};

describe("<CorrelationRow>", () => {
  it("renders only the ok-status hypothesis cards (insufficient ones are dropped)", () => {
    const html = render(
      <CorrelationRow
        results={{
          bpCompliance: okBpCompliance,
          moodPulse: insufficientMoodPulse,
          weightWeekday: okWeightWeekday,
        }}
      />,
    );
    const matches = html.match(/data-slot="correlation-card"/g) ?? [];
    expect(matches.length).toBe(2);
    expect(html).toMatch(/data-kind="bp-compliance"/);
    expect(html).not.toMatch(/data-kind="mood-pulse"/);
    expect(html).toMatch(/data-kind="weight-weekday"/);
  });

  it("renders the correlation-disclaimer once at the row level", () => {
    const html = render(
      <CorrelationRow
        results={{
          bpCompliance: okBpCompliance,
          moodPulse: insufficientMoodPulse,
          weightWeekday: okWeightWeekday,
        }}
      />,
    );
    const matches = html.match(/data-slot="correlation-row-disclaimer"/g) ?? [];
    expect(matches.length).toBe(1);
    expect(html).toContain("Relationships are observational, not causal");
  });

  it("applies the 2-up grid on >= md when 2+ ok cards render", () => {
    const html = render(
      <CorrelationRow
        results={{
          bpCompliance: okBpCompliance,
          moodPulse: insufficientMoodPulse,
          weightWeekday: okWeightWeekday,
        }}
      />,
    );
    expect(html).toMatch(/grid-cols-1/);
    expect(html).toMatch(/md:grid-cols-2/);
  });

  it("collapses to a full-width single column when exactly 1 ok card renders", () => {
    const html = render(
      <CorrelationRow
        results={{
          bpCompliance: okBpCompliance,
          moodPulse: insufficientMoodPulse,
          weightWeekday: insufficientMoodPulse,
        }}
      />,
    );
    expect(html).toMatch(/grid-cols-1/);
    // The 2-up rule must NOT activate when only one card has data —
    // a single card should span 100 % width on its own row instead of
    // half-width with empty space next to it.
    expect(html).not.toMatch(/md:grid-cols-2/);
  });

  it("hides the row entirely (no header, no disclaimer) when zero cards have data", () => {
    const html = render(
      <CorrelationRow
        results={{
          bpCompliance: insufficientMoodPulse,
          moodPulse: insufficientMoodPulse,
          weightWeekday: insufficientMoodPulse,
        }}
      />,
    );
    expect(html).toBe("");
  });

  it("renders German copy when locale=de", () => {
    const html = render(
      <CorrelationRow
        results={{
          bpCompliance: okBpCompliance,
          moodPulse: insufficientMoodPulse,
          weightWeekday: okWeightWeekday,
        }}
      />,
      "de",
    );
    expect(html).toContain("nicht kausal");
  });
});
