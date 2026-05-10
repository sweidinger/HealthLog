import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { InsightsCardPreview } from "../insights-card";
import type { InsightResult, InsightRecommendation } from "@/lib/ai/types";

/**
 * v1.4.16 phase B1b — dashboard InsightsCard preview.
 *
 * The preview is a compact wrapper that surfaces the top 1-2
 * severity-ordered recommendations + a "View all" CTA pointing to
 * the full `/insights` page. Visual language matches the page hero
 * + recommendation grid (Dracula tokens, severity-coloured borders,
 * mini confidence meter).
 */

vi.mock("@/components/charts/health-chart", () => ({
  HealthChart: () => <div data-testid="health-chart-mock" />,
}));
vi.mock("@/components/charts/mood-chart", () => ({
  MoodChart: () => <div data-testid="mood-chart-mock" />,
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
  confidence?: number,
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

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<InsightsCardPreview>", () => {
  it("surfaces only the top 2 severity-ordered recommendations", () => {
    const recs = [
      rec("a", "info", "info-rec"),
      rec("b", "urgent", "urgent-rec"),
      rec("c", "important", "important-rec"),
      rec("d", "suggestion", "suggestion-rec"),
    ];
    const html = render(<InsightsCardPreview insight={buildInsight(recs)} />);
    expect(html).toContain("urgent-rec");
    expect(html).toContain("important-rec");
    // The preview must hide the remaining recs — they live on /insights.
    expect(html).not.toContain("info-rec");
    expect(html).not.toContain("suggestion-rec");
  });

  it("renders the 'View all' CTA pointing to /insights", () => {
    const recs = [rec("a", "urgent", "urgent-rec")];
    const html = render(<InsightsCardPreview insight={buildInsight(recs)} />);
    expect(html).toMatch(/href="\/insights"/);
    expect(html).toMatch(/data-slot="insights-card-view-all"/);
  });

  it("paints a severity-coloured left border on each preview card", () => {
    const recs = [
      rec("a", "urgent", "urgent-rec"),
      rec("b", "important", "important-rec"),
    ];
    const html = render(<InsightsCardPreview insight={buildInsight(recs)} />);
    expect(html).toMatch(/border-l-dracula-red/);
    expect(html).toMatch(/border-l-dracula-orange/);
  });

  it("renders a mini confidence meter inline when confidence is supplied", () => {
    const recs = [rec("a", "urgent", "urgent-rec", 78)];
    const html = render(<InsightsCardPreview insight={buildInsight(recs)} />);
    // The ConfidenceMeter component renders a 'data-slot="confidence-meter"'
    // marker; the preview shows the inline ring/bars variant.
    expect(html).toMatch(/data-slot="confidence-meter"/);
  });

  it("hides the preview entirely when there are no recommendations", () => {
    const html = render(<InsightsCardPreview insight={buildInsight([])} />);
    // The orphan "no recs" state is delegated to the full /insights page.
    // The preview either renders the top recs OR doesn't mount at all.
    expect(html).toBe("");
  });

  it("passes a null insight transparently — no preview", () => {
    const html = render(<InsightsCardPreview insight={null} />);
    expect(html).toBe("");
  });

  it("renders the title slot so dashboard nav can sit alongside", () => {
    const recs = [rec("a", "urgent", "urgent-rec")];
    const html = render(<InsightsCardPreview insight={buildInsight(recs)} />);
    expect(html).toMatch(/data-slot="insights-card-preview"/);
    // Card title text from the existing translation key.
    expect(html).toContain("AI Insights");
  });

  it("German locale — title + view-all CTA translate", () => {
    const recs = [rec("a", "urgent", "urgent-rec")];
    const html = render(
      <InsightsCardPreview insight={buildInsight(recs)} />,
      "de",
    );
    expect(html).toContain("KI-Insights");
    // "View all" → German "Alle ansehen"
    expect(html).toContain("Alle ansehen");
  });
});
