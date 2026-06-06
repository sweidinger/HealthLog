import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { PredictionsPanel } from "../predictions-panel";
import { I18nProvider } from "@/lib/i18n/context";
import type { CyclePrediction, CycleHistoryResponse } from "../types";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

const basePrediction: CyclePrediction = {
  method: "CALENDAR",
  nextPeriodStart: "2026-07-01",
  nextPeriodStartLow: "2026-06-29",
  nextPeriodStartHigh: "2026-07-03",
  fertileWindowStart: null,
  fertileWindowEnd: null,
  predictedOvulation: null,
  ovulationConfirmed: false,
  confidence: 0.8,
  cyclesObserved: 6,
  stillLearning: false,
  disclaimer: "Estimates only, not medical advice.",
};

const emptyHistory: CycleHistoryResponse = {
  cycles: [],
  stats: {
    avgLengthDays: null,
    lengthVariabilityDays: null,
    avgPeriodLengthDays: null,
    regularity: "LEARNING",
  },
};

describe("<PredictionsPanel>", () => {
  it("renders the next-period range and shows the disclaimer under the AVOID_PREGNANCY goal", () => {
    const html = render(
      <PredictionsPanel
        prediction={basePrediction}
        rawChartMode={false}
        history={emptyHistory}
        goal="AVOID_PREGNANCY"
      />,
    );
    expect(html).toContain('data-slot="cycle-disclaimer"');
    expect(html).toContain("Estimates only, not medical advice.");
    // The range (not a single date) renders.
    expect(html).toContain("–");
  });

  it("suppresses the generic estimate disclaimer for non-AVOID_PREGNANCY goals", () => {
    const html = render(
      <PredictionsPanel
        prediction={basePrediction}
        rawChartMode={false}
        history={emptyHistory}
        goal="GENERAL_HEALTH"
      />,
    );
    expect(html).not.toContain('data-slot="cycle-disclaimer"');
    expect(html).not.toContain("Estimates only, not medical advice.");
    // The range still renders.
    expect(html).toContain("–");
  });

  it("renders the fertile window only when the prediction carries one", () => {
    const withFertile: CyclePrediction = {
      ...basePrediction,
      fertileWindowStart: "2026-06-14",
      fertileWindowEnd: "2026-06-19",
      predictedOvulation: "2026-06-17",
    };
    const html = render(
      <PredictionsPanel
        prediction={withFertile}
        rawChartMode={false}
        history={emptyHistory}
      />,
    );
    expect(html).toContain("Fertile window");
    expect(html).toContain("Estimated ovulation");
  });

  it("suppresses fertile-window language when the prediction nulls it (goal-gated server-side)", () => {
    const html = render(
      <PredictionsPanel
        prediction={basePrediction}
        rawChartMode={false}
        history={emptyHistory}
      />,
    );
    expect(html).not.toContain("Fertile window");
  });

  it("shows the still-learning state for an under-3-cycle prediction", () => {
    const html = render(
      <PredictionsPanel
        prediction={{ ...basePrediction, stillLearning: true }}
        rawChartMode={false}
        history={emptyHistory}
      />,
    );
    expect(html).toContain("Still learning");
  });

  it("shows the raw-chart-mode state when predictions are off", () => {
    const html = render(
      <PredictionsPanel
        prediction={null}
        rawChartMode={true}
        history={emptyHistory}
      />,
    );
    expect(html).toContain("Prediction is off");
  });
});
