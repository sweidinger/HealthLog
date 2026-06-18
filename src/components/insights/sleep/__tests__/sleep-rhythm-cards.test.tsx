import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/context";
import { SleepDebtCard } from "../sleep-debt-card";
import { ChronotypeCard } from "../chronotype-card";
import type { SleepDebtDto, ChronotypeDto } from "../use-sleep-rhythm";

/**
 * v1.17.0 — sleep-debt + chronotype card rendering, with a focus on the calm
 * NOT-YET-READY states (partial / learning): both must show a "still learning"
 * nudge and NEVER assert a debt total or a chronotype band off thin data.
 */
function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const PARTIAL_DEBT: SleepDebtDto = {
  state: "partial",
  debtMinutes: 0,
  needMinutes: 420,
  nightsCounted: 3,
  windowNights: 14,
  nightsUntilReady: 4,
};

const READY_DEBT: SleepDebtDto = {
  state: "ready",
  debtMinutes: 600,
  needMinutes: 420,
  nightsCounted: 10,
  windowNights: 14,
  nightsUntilReady: 0,
};

const LEARNING_CHRONO: ChronotypeDto = {
  state: "learning",
  msfMinutes: null,
  msfScMinutes: null,
  band: null,
  socialJetlagMinutes: null,
  freeNightsCounted: 1,
  workNightsCounted: 5,
  freeNightsUntilReady: 2,
};

const READY_CHRONO: ChronotypeDto = {
  state: "ready",
  msfMinutes: 4 * 60 + 30, // 04:30
  msfScMinutes: 4 * 60, // 04:00
  band: "intermediate",
  socialJetlagMinutes: 75,
  freeNightsCounted: 6,
  workNightsCounted: 14,
  freeNightsUntilReady: 0,
};

describe("<SleepDebtCard>", () => {
  it("shows the learning nudge in the partial state, not a debt total", () => {
    const html = render(<SleepDebtCard debt={PARTIAL_DEBT} />);
    expect(html).toContain("Still learning your sleep");
    expect(html).toContain("3 nights");
    // No asserted "short" figure while partial.
    expect(html).not.toContain("short");
  });

  it("asserts the cumulative debt in the ready state", () => {
    const html = render(<SleepDebtCard debt={READY_DEBT} />);
    // 600 min = 10h 0m short.
    expect(html).toContain("10h 0m short");
    expect(html).toContain("14 nights");
  });

  it("inherits the standard Card rhythm (no compact override)", () => {
    const partial = render(<SleepDebtCard debt={PARTIAL_DEBT} />);
    const ready = render(<SleepDebtCard debt={READY_DEBT} />);
    for (const html of [partial, ready]) {
      expect(html).not.toContain("gap-2 py-4 md:gap-2 md:py-4");
      expect(html).toContain("md:py-6");
      // Semantic info token, not the raw Dracula cyan.
      expect(html).toContain("text-info");
      expect(html).not.toContain("text-dracula-cyan");
    }
  });

  it("shows the caught-up state at zero debt", () => {
    const html = render(
      <SleepDebtCard debt={{ ...READY_DEBT, debtMinutes: 0 }} />,
    );
    expect(html).toContain("All caught up");
  });
});

describe("<ChronotypeCard>", () => {
  it("shows the learning state and asserts NO band off thin data", () => {
    const html = render(<ChronotypeCard chronotype={LEARNING_CHRONO} />);
    expect(html).toContain("Still learning your rhythm");
    expect(html).toContain("1 of 3 free nights");
    // No band label leaks in the learning state — none of the five MCTQ
    // class labels appears.
    expect(html).not.toContain("Intermediate type");
    expect(html).not.toContain("Morning type");
    expect(html).not.toContain("Evening type");
  });

  it("shows the band + mid-sleep clock in the ready state", () => {
    const html = render(<ChronotypeCard chronotype={READY_CHRONO} />);
    expect(html).toContain("Intermediate type");
    expect(html).toContain("04:30");
  });

  it("renders the band as a labelled top-right corner readout, not a badge", () => {
    const html = render(<ChronotypeCard chronotype={READY_CHRONO} />);
    // The labelled corner carries both the "Chronotype" label and the value.
    expect(html).toContain('data-slot="chronotype-corner"');
    expect(html).toContain("Chronotype");
    expect(html).toContain("Intermediate type");
  });

  it("inherits the standard Card rhythm (no compact override)", () => {
    const learning = render(<ChronotypeCard chronotype={LEARNING_CHRONO} />);
    const ready = render(<ChronotypeCard chronotype={READY_CHRONO} />);
    for (const html of [learning, ready]) {
      expect(html).not.toContain("gap-2 py-4 md:gap-2 md:py-4");
      expect(html).toContain("md:py-6");
      expect(html).toContain("text-info");
      expect(html).not.toContain("text-dracula-cyan");
    }
  });

  it("keeps social jetlag + MSFsc behind the advanced disclosure (collapsed by default)", () => {
    const html = render(<ChronotypeCard chronotype={READY_CHRONO} />);
    // The toggle is present, the advanced detail is not rendered until opened.
    expect(html).toContain("Advanced");
    expect(html).not.toContain("social jetlag");
    expect(html).not.toContain("Corrected mid-sleep");
  });
});
