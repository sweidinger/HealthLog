import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { CalendarResponse } from "../types";
import type { CycleInsightsResponse } from "../use-cycle";
import type { CyclePhaseCrosstabRow } from "../cycle-phase-crosstab";

/**
 * v1.15.2 — the gated cycle-insights summary teaser on the main Insights page.
 *
 * The card itself is mounted ONLY when `user.cycleTrackingEnabled` is true (a
 * page-level gate); these tests cover the card's own behaviour given that gate:
 * it sources the phase + cycle day from the SAME calendar read the wheel uses,
 * renders the shared FDR-gated headline, deep-links to the cycle insights tab,
 * and stays silent while resolving / on a hard error so the overview never
 * shows a broken cycle teaser.
 *
 * The cycle reads are mocked at the hook boundary so the SSR snapshot is
 * deterministic without a TanStack-Query client / network round-trip.
 */

// `next/link` → a plain anchor in the static snapshot.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const calendarState = vi.hoisted(() => ({
  current: {
    data: undefined as CalendarResponse | undefined,
    isLoading: false,
    isError: false,
  },
}));
const insightsState = vi.hoisted(() => ({
  current: {
    data: undefined as CycleInsightsResponse | undefined,
    isError: false,
  },
}));

vi.mock("../use-cycle", async () => {
  const actual =
    await vi.importActual<typeof import("../use-cycle")>("../use-cycle");
  return {
    ...actual,
    useCycleCalendar: () => calendarState.current,
    useCycleInsights: () => insightsState.current,
  };
});

import { CycleInsightSummaryCard } from "../cycle-insight-summary-card";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

/** Build a calendar read where `today` sits on a LUTEAL day at day-of-cycle 3
 *  (a short MENSTRUAL run → LUTEAL today, so `deriveWheelState` resolves a
 *  phase + day). */
function lutealCalendar(today: string): CalendarResponse {
  // Three consecutive days ending today: MENSTRUAL, FOLLICULAR, LUTEAL.
  const days = [
    { date: shift(today, -2), phase: "MENSTRUAL" as const },
    { date: shift(today, -1), phase: "FOLLICULAR" as const },
    { date: today, phase: "LUTEAL" as const },
  ];
  return {
    days: days as unknown as CalendarResponse["days"],
    profile: {} as CalendarResponse["profile"],
    prediction: null,
  } as CalendarResponse;
}

function shift(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const headlineRow: CyclePhaseCrosstabRow = {
  metricKey: "restingHeartRate",
  display: "bpm",
  lutealDays: 12,
  follicularDays: 11,
  lutealAvg: 64,
  follicularAvg: 60,
  delta: 4,
  pValue: 0.01,
  qValue: 0.03,
  confidence: "high",
};

beforeEach(() => {
  calendarState.current = {
    data: undefined,
    isLoading: false,
    isError: false,
  };
  insightsState.current = { data: undefined, isError: false };
});

describe("<CycleInsightSummaryCard>", () => {
  it("renders the current phase, cycle day, headline, and the deep-link", () => {
    calendarState.current = {
      data: lutealCalendar(todayYmd()),
      isLoading: false,
      isError: false,
    };
    insightsState.current = {
      data: { rows: [headlineRow], headline: headlineRow, symptomPatterns: [] },
      isError: false,
    };

    const html = render(<CycleInsightSummaryCard />);

    // Phase name + cycle-day read (day 3 of the 3-day run).
    expect(html).toContain("Luteal");
    expect(html).toContain("Day 3 of your cycle");
    // The shared FDR-gated headline (resting-heart-rate phrasing).
    expect(html).toContain("resting heart rate");
    // Deep-link into the single source of truth (cycle insights tab).
    expect(html).toContain('href="/cycle?tab=insights"');
    expect(html).toContain("View cycle insights");
    expect(html).toContain('data-phase="LUTEAL"');
  });

  it("shows the honest empty headline line when nothing cleared the FDR gate", () => {
    calendarState.current = {
      data: lutealCalendar(todayYmd()),
      isLoading: false,
      isError: false,
    };
    insightsState.current = {
      data: { rows: [], headline: null, symptomPatterns: [] },
      isError: false,
    };

    const html = render(<CycleInsightSummaryCard />);
    // Calm "keep logging" line from the shared <CyclePhaseHeadline>.
    expect(html).toContain("Not enough cycles");
    // Still a teaser with a working deep-link.
    expect(html).toContain('href="/cycle?tab=insights"');
  });

  it("renders nothing while the calendar read is still resolving", () => {
    calendarState.current = { data: undefined, isLoading: true, isError: false };
    const html = render(<CycleInsightSummaryCard />);
    expect(html).toBe("");
  });

  it("renders nothing on a hard calendar read error", () => {
    calendarState.current = {
      data: undefined,
      isLoading: false,
      isError: true,
    };
    const html = render(<CycleInsightSummaryCard />);
    expect(html).toBe("");
  });
});
