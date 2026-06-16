import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { PhaseDayHeader } from "../log-day-sheet";
import { I18nProvider } from "@/lib/i18n/context";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

const okGate = {
  predictionEnabled: true,
  rawChartMode: false,
  cyclesObserved: 4,
};

describe("<PhaseDayHeader> (honesty gate)", () => {
  it("shows the phase + day when the gate passes", () => {
    const html = render(
      <PhaseDayHeader phase="OVULATORY" dayOfCycle={14} {...okGate} />,
    );
    expect(html).toContain('data-slot="cycle-log-phase-header"');
    expect(html).toContain('data-phase="OVULATORY"');
    // "Day 14 · Ovulatory" — the phase word is only claimed under a passing gate.
    expect(html).toContain("Day 14");
    expect(html).toContain("Ovulatory");
  });

  it("makes no phase claim when prediction is off (neutral day header)", () => {
    const html = render(
      <PhaseDayHeader
        phase="OVULATORY"
        dayOfCycle={14}
        predictionEnabled={false}
        rawChartMode={false}
        cyclesObserved={4}
      />,
    );
    expect(html).toContain('data-phase="none"');
    // Still anchors to the day count, but never names the phase.
    expect(html).toContain("Day 14");
    expect(html).not.toContain("Ovulatory");
  });

  it("makes no phase claim with too few observed cycles", () => {
    const html = render(
      <PhaseDayHeader
        phase="LUTEAL"
        dayOfCycle={20}
        predictionEnabled
        rawChartMode={false}
        cyclesObserved={1}
      />,
    );
    expect(html).toContain('data-phase="none"');
    expect(html).not.toContain("Luteal");
  });

  it("renders nothing when neither a trustworthy phase nor a day count exists", () => {
    const html = render(
      <PhaseDayHeader
        phase={null}
        dayOfCycle={null}
        predictionEnabled={false}
        rawChartMode={false}
        cyclesObserved={0}
      />,
    );
    expect(html).toBe("");
  });
});
