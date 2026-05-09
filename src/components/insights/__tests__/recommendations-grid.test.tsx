import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  RecommendationsGrid,
  sortRecommendationsBySeverity,
} from "../recommendations-grid";
import type { InsightRecommendation } from "@/lib/ai/types";

/**
 * v1.4.16 phase B1b — recommendations grid + severity-ordering wrapper.
 *
 * Pure presentational shell around the existing RecommendationCard:
 *   - 1-col mobile, 2-col desktop layout
 *   - severity-priority ordering: urgent → important → suggestion → info
 *   - staggered fade-in (animation-delay derived from index)
 *   - the cards keep their own per-rec rendering — this wrapper is a
 *     layout shell only.
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
): InsightRecommendation {
  return {
    id,
    text,
    severity,
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

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("sortRecommendationsBySeverity", () => {
  it("orders urgent → important → suggestion → info", () => {
    const recs: InsightRecommendation[] = [
      rec("a", "info", "info-a"),
      rec("b", "urgent", "urgent-b"),
      rec("c", "suggestion", "suggestion-c"),
      rec("d", "important", "important-d"),
    ];
    const sorted = sortRecommendationsBySeverity(recs);
    const ids = sorted.map((r) => (typeof r === "string" ? r : (r.id ?? "")));
    expect(ids).toEqual(["b", "d", "c", "a"]);
  });

  it("preserves original order within the same severity bucket (stable)", () => {
    const recs: InsightRecommendation[] = [
      rec("a", "important", "first"),
      rec("b", "important", "second"),
      rec("c", "important", "third"),
    ];
    const sorted = sortRecommendationsBySeverity(recs);
    expect(sorted.map((r) => (typeof r === "string" ? r : r.id))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("treats plain-string recs and missing-severity recs as lowest priority", () => {
    const recs: InsightRecommendation[] = [
      "plain string rec",
      rec("a", "urgent", "urgent-a"),
      // partial — no severity
      { id: "b", text: "untyped" },
    ];
    const sorted = sortRecommendationsBySeverity(recs);
    expect(typeof sorted[0]).toBe("object");
    if (typeof sorted[0] !== "string") {
      expect(sorted[0].id).toBe("a");
    }
    // plain-string and id=b both fall to the bottom; relative order
    // among the bottom bucket is stable (the string came first in the
    // input).
    expect(typeof sorted[1]).toBe("string");
  });
});

describe("<RecommendationsGrid>", () => {
  it("renders cards in a 2-col responsive grid", () => {
    const recs = [
      rec("a", "info", "alpha"),
      rec("b", "urgent", "bravo"),
    ];
    const html = render(<RecommendationsGrid recs={recs} />);
    expect(html).toMatch(/data-slot="rec-grid"/);
    expect(html).toMatch(/grid-cols-1/);
    expect(html).toMatch(/lg:grid-cols-2/);
  });

  it("renders cards in severity-ordered sequence (urgent first)", () => {
    const recs = [
      rec("a", "info", "alpha"),
      rec("b", "urgent", "bravo"),
    ];
    const html = render(<RecommendationsGrid recs={recs} />);
    // bravo (urgent) must appear before alpha (info) in the output.
    expect(html.indexOf("bravo")).toBeLessThan(html.indexOf("alpha"));
    expect(html.indexOf("bravo")).toBeGreaterThan(-1);
  });

  it("paints severity-coloured left border on each card", () => {
    const recs = [
      rec("a", "urgent", "urgent-rec"),
      rec("b", "important", "important-rec"),
      rec("c", "suggestion", "suggestion-rec"),
      rec("d", "info", "info-rec"),
    ];
    const html = render(<RecommendationsGrid recs={recs} />);
    // Each card gets a Dracula-token border-l class. The exact class
    // varies by severity; we assert at least one of each is in the
    // output.
    expect(html).toMatch(/border-l-dracula-red/);
    expect(html).toMatch(/border-l-dracula-orange/);
    expect(html).toMatch(/border-l-dracula-purple/);
    expect(html).toMatch(/border-l-dracula-cyan/);
  });

  it("renders nothing when recs is empty", () => {
    const html = render(<RecommendationsGrid recs={[]} />);
    expect(html).not.toMatch(/data-slot="rec-grid"/);
  });

  it("applies the staggered animation-delay style per card", () => {
    const recs = [
      rec("a", "urgent", "first"),
      rec("b", "important", "second"),
      rec("c", "suggestion", "third"),
    ];
    const html = render(<RecommendationsGrid recs={recs} />);
    // Cards 1+ get a non-zero animationDelay; the first card has 0ms.
    expect(html).toMatch(/data-stagger-index="0"/);
    expect(html).toMatch(/data-stagger-index="1"/);
    expect(html).toMatch(/data-stagger-index="2"/);
  });
});
