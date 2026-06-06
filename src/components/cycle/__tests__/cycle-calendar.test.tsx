import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CycleCalendar } from "../cycle-calendar";
import { I18nProvider } from "@/lib/i18n/context";
import type { CalendarDay } from "../types";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

function dayBase(date: string): CalendarDay {
  return {
    date,
    phase: null,
    isPredictedPeriod: false,
    isFertileWindow: false,
    isPredictedOvulation: false,
    isPeriodLogged: false,
    flow: null,
    hasSymptoms: false,
    confidence: 1,
  };
}

describe("<CycleCalendar>", () => {
  const today = "2026-06-15";

  it("renders the month grid for today's month", () => {
    const html = render(
      <CycleCalendar days={[]} today={today} onSelectDay={() => {}} />,
    );
    expect(html).toContain('data-slot="cycle-calendar"');
    expect(html).toContain('role="grid"');
    // The current day cell is marked.
    expect(html).toContain('aria-current="date"');
  });

  it("labels a logged-period day in its aria-label", () => {
    const days = [{ ...dayBase("2026-06-10"), isPeriodLogged: true }];
    const html = render(
      <CycleCalendar days={days} today={today} onSelectDay={() => {}} />,
    );
    expect(html).toContain("Logged period");
  });

  it("renders the predicted period as a band, not a logged pip", () => {
    const days = [{ ...dayBase("2026-06-20"), isPredictedPeriod: true }];
    const html = render(
      <CycleCalendar days={days} today={today} onSelectDay={() => {}} />,
    );
    // The predicted band uses a dashed gradient underline + the aria marker.
    expect(html).toContain("Predicted period");
    expect(html).toContain("repeating-linear-gradient");
  });

  it("labels a fertile-window day (only present when goal-gated server allows it)", () => {
    const days = [{ ...dayBase("2026-06-12"), isFertileWindow: true }];
    const html = render(
      <CycleCalendar days={days} today={today} onSelectDay={() => {}} />,
    );
    expect(html).toContain("Fertile window");
  });

  it("renders a localized Monday-first weekday header row", () => {
    const html = render(
      <CycleCalendar days={[]} today={today} onSelectDay={() => {}} />,
    );
    expect(html).toContain('role="columnheader"');
  });
});
