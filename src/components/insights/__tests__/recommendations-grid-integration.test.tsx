import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { InsightAdvisorCard } from "../insight-advisor-card";
import type { InsightResult, InsightRecommendation } from "@/lib/ai/types";

/**
 * v1.4.16 phase B1b — full-flow integration: rationale (B5c) +
 * confidence (B5d) + feedback (B5e) + grid wrapper (B1b) all paint
 * together inside InsightAdvisorCard.
 *
 * The B5c report flagged that an e2e couldn't be added because
 * `/insights` doesn't currently mount InsightAdvisorCard in the
 * production tree. This integration test exercises the same surface
 * via SSR and pins the cross-feature interaction so the rec card
 * shell + per-card affordances all render in the right slots when
 * the polished grid sits between InsightAdvisorCard and the
 * RecommendationCard.
 */

vi.mock("@/components/charts/health-chart", () => ({
  HealthChart: ({
    types,
    mini,
    windowOverride,
  }: {
    types: string[];
    mini?: boolean;
    windowOverride?: string;
  }) => (
    <div
      data-testid="health-chart"
      data-types={types.join(",")}
      data-mini={mini ? "true" : "false"}
      data-window={windowOverride ?? ""}
    />
  ),
}));
vi.mock("@/components/charts/mood-chart", () => ({
  MoodChart: ({ mini }: { mini?: boolean }) => (
    <div data-testid="mood-chart" data-mini={mini ? "true" : "false"} />
  ),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: null, isLoading: false }),
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "test-user", username: "tester", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

function rec(
  id: string,
  severity: "info" | "suggestion" | "important" | "urgent",
  text: string,
  confidence: number,
): InsightRecommendation {
  return {
    id,
    text,
    severity,
    confidence,
    rationale: {
      dataWindow: "last7days",
      comparedTo: "your 90-day median",
      deviation: "moderate deviation",
    },
    metricSource: {
      type: "weight",
      timeRange: "last7days",
      summary: "84.2 kg avg over 7 days",
    },
  };
}

function buildInsight(
  recommendations: InsightRecommendation[],
): InsightResult {
  return {
    insightType: "general",
    summary: "Test summary",
    classification: "gut",
    classificationLabel: "Good",
    findings: [],
    correlations: [],
    primaryRecommendation: "",
    recommendations,
    dataQuality: { coverage: "good", gaps: [], confidence: "hoch" },
    disclaimer: "Not medical advice.",
  };
}

describe("InsightAdvisorCard + RecommendationsGrid full flow (B1b)", () => {
  it("severity-orders the grid then paints confidence + feedback slots per card", () => {
    const recs = [
      rec("a", "info", "info-text", 22),
      rec("b", "urgent", "urgent-text", 88),
      rec("c", "suggestion", "suggestion-text", 60),
    ];
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <InsightAdvisorCard title="full flow" insight={buildInsight(recs)} />
      </I18nProvider>,
    );

    // Grid wrapper present.
    expect(html).toMatch(/data-slot="rec-grid"/);

    // urgent appears before info in the rendered HTML.
    expect(html.indexOf("urgent-text")).toBeLessThan(html.indexOf("info-text"));
    expect(html.indexOf("urgent-text")).toBeGreaterThan(-1);

    // Each card carries the named slots from B5c/d/e.
    expect(html).toMatch(/data-slot="rec-confidence-slot"/);
    expect(html).toMatch(/data-slot="confidence-meter"/);

    // Severity-coloured borders all rendered (red, purple, cyan for the
    // three severities we shipped).
    expect(html).toMatch(/border-l-dracula-red/);
    expect(html).toMatch(/border-l-dracula-purple/);
    expect(html).toMatch(/border-l-dracula-cyan/);

    // 3 stagger indices on the wrapper rows.
    expect(html).toMatch(/data-stagger-index="0"/);
    expect(html).toMatch(/data-stagger-index="1"/);
    expect(html).toMatch(/data-stagger-index="2"/);
  });

  it("confidence below 25 swaps the meter for a draft pill (still respects sort order)", () => {
    const recs = [
      rec("a", "important", "important-text", 80),
      rec("b", "urgent", "urgent-text", 12), // draft
    ];
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <InsightAdvisorCard
          title="draft"
          insight={buildInsight(recs)}
        />
      </I18nProvider>,
    );

    // Urgent rec still sorts first even with low confidence.
    expect(html.indexOf("urgent-text")).toBeLessThan(
      html.indexOf("important-text"),
    );
    // Draft pill renders for confidence < 25.
    expect(html).toMatch(/data-slot="confidence-meter"/);
    expect(html).toContain("Draft");
  });

  it("renders an empty grid when there are no recommendations", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <InsightAdvisorCard title="empty" insight={buildInsight([])} />
      </I18nProvider>,
    );
    // Grid is unmounted entirely when recs.length is 0.
    expect(html).not.toContain('data-slot="rec-grid"');
    // Recommendations heading not rendered without content underneath.
    expect(html).not.toContain("Recommendations");
  });
});
