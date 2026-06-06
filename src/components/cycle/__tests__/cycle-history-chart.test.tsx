import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CycleHistoryChart } from "../cycle-history-chart";
import { I18nProvider } from "@/lib/i18n/context";
import type { CycleHistoryResponse, MenstrualCycleDTO } from "../types";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

function cycle(over: Partial<MenstrualCycleDTO>): MenstrualCycleDTO {
  return {
    id: over.id ?? "c1",
    startDate: over.startDate ?? "2026-01-01",
    endDate: over.endDate ?? "2026-01-28",
    periodEndDate: over.periodEndDate ?? "2026-01-05",
    lengthDays: over.lengthDays ?? 28,
    ovulationDate: over.ovulationDate ?? null,
    ovulationConfirmed: over.ovulationConfirmed ?? false,
    isPredicted: over.isPredicted ?? false,
    syncVersion: 1,
    updatedAt: "2026-01-28T00:00:00Z",
  };
}

const REGULAR_HISTORY: CycleHistoryResponse = {
  cycles: [
    cycle({ id: "a", startDate: "2026-01-01", lengthDays: 28 }),
    cycle({ id: "b", startDate: "2026-01-29", lengthDays: 29 }),
    cycle({
      id: "c",
      startDate: "2026-02-27",
      lengthDays: 27,
      ovulationConfirmed: true,
      ovulationDate: "2026-03-13",
    }),
  ],
  stats: {
    avgLengthDays: 28,
    lengthVariabilityDays: 1,
    avgPeriodLengthDays: 5,
    regularity: "REGULAR",
  },
};

describe("<CycleHistoryChart>", () => {
  it("renders one bar per observed cycle with stable data-attrs", () => {
    const html = render(<CycleHistoryChart history={REGULAR_HISTORY} />);
    expect(html).toContain('data-slot="cycle-history-chart"');
    // Three observed cycles → three bars.
    const bars = html.match(/data-cycle-bar="true"/g) ?? [];
    expect(bars).toHaveLength(3);
    // The period segment is drawn for each bar with a logged period end.
    expect(html).toContain('data-period-segment="true"');
    // The mean baseline rule is present.
    expect(html).toContain('data-avg-line="true"');
  });

  it("surfaces the regularity classification on a stat chip", () => {
    const html = render(<CycleHistoryChart history={REGULAR_HISTORY} />);
    expect(html).toContain('data-regularity="REGULAR"');
    expect(html).toContain("Regular");
  });

  it("draws a confirmed-ovulation tick only for confirmed cycles", () => {
    const html = render(<CycleHistoryChart history={REGULAR_HISTORY} />);
    const ticks = html.match(/data-ovulation-tick="true"/g) ?? [];
    // Only the third cycle carries a confirmed ovulation date.
    expect(ticks).toHaveLength(1);
  });

  it("excludes predicted cycles from the chart", () => {
    const withPredicted: CycleHistoryResponse = {
      ...REGULAR_HISTORY,
      cycles: [
        ...REGULAR_HISTORY.cycles,
        cycle({ id: "future", startDate: "2026-03-26", isPredicted: true }),
      ],
    };
    const html = render(<CycleHistoryChart history={withPredicted} />);
    const bars = html.match(/data-cycle-bar="true"/g) ?? [];
    expect(bars).toHaveLength(3);
  });

  it("shows the empty state when there is no data", () => {
    const html = render(<CycleHistoryChart history={undefined} />);
    expect(html).toContain("No cycles recorded yet.");
    expect(html).not.toContain('data-cycle-bar="true"');
  });
});
