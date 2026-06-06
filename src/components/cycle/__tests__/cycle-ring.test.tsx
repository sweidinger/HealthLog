import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CycleRing } from "../cycle-ring";
import { I18nProvider } from "@/lib/i18n/context";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<CycleRing>", () => {
  it("renders the root data-slot tagged with the active phase", () => {
    const html = render(
      <CycleRing
        dayOfCycle={8}
        cycleLength={28}
        phase="FOLLICULAR"
        spans={[
          { phase: "MENSTRUAL", fraction: 0.18 },
          { phase: "FOLLICULAR", fraction: 0.32 },
          { phase: "OVULATORY", fraction: 0.1 },
          { phase: "LUTEAL", fraction: 0.4 },
        ]}
      />,
    );
    expect(html).toContain('data-slot="cycle-ring"');
    expect(html).toContain('data-phase="FOLLICULAR"');
  });

  it("shows the day-of-cycle number as centred text", () => {
    const html = render(
      <CycleRing dayOfCycle={12} cycleLength={28} phase="OVULATORY" />,
    );
    expect(html).toContain(">12<");
  });

  it("carries a phase-aware aria-label (never colour-only)", () => {
    const html = render(
      <CycleRing dayOfCycle={3} cycleLength={28} phase="MENSTRUAL" />,
    );
    expect(html).toContain('role="img"');
    expect(html).toContain("aria-label");
    // The label restates the day + phase.
    expect(html).toContain("3");
  });

  it("renders the no-cycle state for a null day with a fallback aria-label", () => {
    const html = render(
      <CycleRing dayOfCycle={null} cycleLength={null} phase={null} />,
    );
    expect(html).toContain('data-phase="none"');
    expect(html).toContain('role="img"');
  });
});
