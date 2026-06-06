import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { PhaseEducationCard } from "../phase-education-card";
import { I18nProvider } from "@/lib/i18n/context";
import type { SymptomPhaseRow } from "../use-cycle";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

const lutealCramps: SymptomPhaseRow = {
  symptomKey: "cramps",
  counts: { MENSTRUAL: 1, FOLLICULAR: 0, OVULATORY: 0, LUTEAL: 6 },
  total: 7,
  topPhase: "LUTEAL",
  topShare: 6 / 7,
};
const follicularFatigue: SymptomPhaseRow = {
  symptomKey: "fatigue",
  counts: { MENSTRUAL: 0, FOLLICULAR: 5, OVULATORY: 0, LUTEAL: 1 },
  total: 6,
  topPhase: "FOLLICULAR",
  topShare: 5 / 6,
};

const okGate = {
  predictionEnabled: true,
  rawChartMode: false,
  cyclesObserved: 4,
};

describe("<PhaseEducationCard>", () => {
  it("renders phase name + descriptive line when the gate passes", () => {
    const html = render(
      <PhaseEducationCard
        phase="LUTEAL"
        symptomPatterns={[lutealCramps, follicularFatigue]}
        {...okGate}
      />,
    );
    expect(html).toContain("Luteal");
    expect(html).toContain("progesterone"); // curated whatsHappening line
    expect(html).toContain('data-phase="LUTEAL"');
  });

  it("shows only the user's OWN symptoms that cluster in the active phase", () => {
    const html = render(
      <PhaseEducationCard
        phase="LUTEAL"
        symptomPatterns={[lutealCramps, follicularFatigue]}
        {...okGate}
      />,
    );
    // cramps clusters in luteal → shown; fatigue clusters in follicular → not.
    expect(html).toContain("Cramps");
    expect(html).not.toContain("Fatigue");
  });

  it("falls back to the still-learning line when fewer than three cycles", () => {
    const html = render(
      <PhaseEducationCard
        phase="LUTEAL"
        symptomPatterns={[lutealCramps]}
        predictionEnabled
        rawChartMode={false}
        cyclesObserved={2}
      />,
    );
    expect(html).toContain("Still learning your cycle");
    expect(html).not.toContain("progesterone");
    expect(html).not.toContain("Cramps");
  });

  it("falls back to still-learning in raw-chart mode / prediction disabled", () => {
    const raw = render(
      <PhaseEducationCard
        phase="LUTEAL"
        symptomPatterns={[lutealCramps]}
        predictionEnabled
        rawChartMode
        cyclesObserved={9}
      />,
    );
    expect(raw).toContain("Still learning your cycle");

    const off = render(
      <PhaseEducationCard
        phase="LUTEAL"
        symptomPatterns={[lutealCramps]}
        predictionEnabled={false}
        rawChartMode={false}
        cyclesObserved={9}
      />,
    );
    expect(off).toContain("Still learning your cycle");
  });

  it("renders the chip row when the user has symptoms clustering in this phase", () => {
    const html = render(
      <PhaseEducationCard
        phase="LUTEAL"
        symptomPatterns={[lutealCramps]}
        {...okGate}
      />,
    );
    expect(html).toContain("progesterone");
    expect(html).toContain("cycle-phase-education-chips");
    expect(html).toContain("Cramps");
  });
});
