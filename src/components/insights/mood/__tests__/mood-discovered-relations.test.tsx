import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

// Signed-in stub so the `enabled: isAuthenticated` gate opens without a fetch.
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1" },
    isLoading: false,
    isAuthenticated: true,
    error: null,
    refetch: () => {},
  }),
}));

import { MoodDiscoveredRelations } from "../mood-discovered-relations";

interface DiscoveredCorrelation {
  behaviour: string;
  outcome: string;
  n: number;
  r: number;
  pValue: number;
  qValue: number;
  interpretation: string;
  lagDays: number;
}

function renderWith(
  discovered: DiscoveredCorrelation[],
  pairsTested = discovered.length,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(queryKeys.insightsCorrelations(), {
    discovered,
    pairsTested,
    fdrQ: 0.1,
    minPairs: 20,
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <MoodDiscoveredRelations />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function pair(over: Partial<DiscoveredCorrelation>): DiscoveredCorrelation {
  return {
    behaviour: "TIME_IN_DAYLIGHT",
    outcome: "MOOD",
    n: 40,
    r: 0.5,
    pValue: 0.001,
    qValue: 0.02,
    interpretation: "",
    lagDays: 1,
    ...over,
  };
}

describe("<MoodDiscoveredRelations>", () => {
  it("renders nothing without discovered data (loading / disabled surface)", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en">
          <MoodDiscoveredRelations />
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(html).toBe("");
  });

  it("renders nothing when no discovered pair involves mood", () => {
    const html = renderWith([
      pair({ behaviour: "ACTIVITY_STEPS", outcome: "SLEEP_DURATION" }),
    ]);
    expect(html).toBe("");
  });

  it("phrases a behaviour → next-day mood pair (mood as outcome)", () => {
    const html = renderWith([
      pair({ behaviour: "TIME_IN_DAYLIGHT", outcome: "MOOD", r: 0.5 }),
    ]);
    expect(html).toContain('data-mood-role="outcome"');
    expect(html).toContain('data-direction="up"');
    // factor label resolves to the localized measurement name
    expect(html).toContain("Time in Daylight");
    expect(html).toContain("higher next-day mood");
    // v1.12.4 (C4) — the n/r/q detail moved off the visible sub-row into a
    // focusable explainer icon (its tooltip content is portalled on open, so
    // it is absent from the static markup). Assert the icon is wired per pair
    // instead of the inline stat string.
    expect(html).toContain('aria-label="How this was computed"');
  });

  it("phrases a mood → next-day outcome pair", () => {
    const html = renderWith([
      pair({ behaviour: "MOOD", outcome: "SLEEP_DURATION", r: -0.4 }),
    ]);
    expect(html).toContain('data-mood-role="behaviour"');
    expect(html).toContain('data-direction="down"');
    expect(html).toContain("Sleep");
    expect(html).toContain("lower next-day");
  });

  it("filters to mood pairs and folds the full-family footer into the header explainer", () => {
    const html = renderWith(
      [
        pair({ behaviour: "TIME_IN_DAYLIGHT", outcome: "MOOD" }),
        pair({ behaviour: "ACTIVITY_STEPS", outcome: "WEIGHT" }), // non-mood
      ],
      12,
    );
    expect((html.match(/data-slot="mood-discovered-pair"/g) ?? []).length).toBe(
      1,
    );
    // v1.12.4 (C3) — the false-discovery footer (denominator = the full
    // behaviour×outcome family the engine tested, i.e. 12, not the mood-only
    // subset) + the observational disclaimer were two full-width footnote
    // rows; both fold into a single header explainer icon now. Its tooltip
    // content is portalled on open, so assert the trigger exists rather than
    // the (now hidden) footer string.
    expect(
      (html.match(/aria-label="How this was computed"/g) ?? []).length,
    ).toBeGreaterThanOrEqual(1);
    // The two old inline footnote rows are gone from the static markup.
    expect(html).not.toContain("day-to-day pairs tested");
  });
});
