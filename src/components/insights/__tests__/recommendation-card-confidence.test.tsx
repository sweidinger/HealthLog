import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/context";
import { RecommendationCard } from "../recommendation-card";

vi.mock("@/components/charts/health-chart", () => ({
  HealthChart: () => <div data-testid="health-chart-mock" />,
}));

vi.mock("@/components/charts/mood-chart", () => ({
  MoodChart: () => <div data-testid="mood-chart-mock" />,
}));

// B5e wired RecommendationFeedback into the rec card; that component
// pulls in useAuth + useMutation from tanstack-query, both of which
// need stubbing for SSR rendering in tests.
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

/**
 * v1.4.16 phase B5d — confidence meter wiring inside
 * `<RecommendationCard>`.
 *
 * The card reserves a `data-slot="rec-confidence-slot"` placeholder
 * (B5c). B5d fills that slot with `<ConfidenceMeter>`. Behaviour:
 *
 *   - rec.confidence undefined -> slot stays empty (legacy payload).
 *   - >=50 -> meter only.
 *   - 25..49 -> meter + low-confidence caption inside the expanded
 *     rationale card ("Low confidence — based on limited data").
 *   - <25 -> "draft" pill replaces the meter (handled by
 *     <ConfidenceMeter> itself); the low-confidence caption ALSO
 *     surfaces because draft <= low.
 *
 * The meter sits in the collapsed-row slot so users can see the
 * confidence at a glance without expanding.
 */

const baseRationale = {
  dataWindow: "last7days" as const,
  comparedTo: "your 90-day median (122/78)",
  deviation: "+16/+8 mmHg above baseline over 9 of 9 readings",
};

const recBase = {
  id: "rec-1",
  text: "Discuss home BP log with your physician.",
  severity: "important" as const,
  rationale: baseRationale,
  metricSource: {
    type: "bloodPressure",
    timeRange: "last7days",
    summary: "avg 138/86 across 9 readings",
  },
};

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<RecommendationCard> — confidence slot wiring", () => {
  it("renders ConfidenceMeter inside rec-confidence-slot when confidence is set", () => {
    const html = render(
      <RecommendationCard rec={{ ...recBase, confidence: 85 }} index={0} />,
    );
    // Slot wraps the meter
    expect(html).toMatch(
      /data-slot="rec-confidence-slot"[\s\S]*?data-slot="confidence-meter"/,
    );
    expect(html).toContain('data-confidence-band="high"');
  });

  it("leaves rec-confidence-slot empty when rec has no confidence (legacy)", () => {
    const html = render(<RecommendationCard rec={recBase} index={0} />);
    // Slot is present but should not contain a confidence-meter inside it.
    expect(html).toMatch(/data-slot="rec-confidence-slot"/);
    expect(html).not.toContain('data-slot="confidence-meter"');
  });

  it("yellow band for medium-confidence (50-79)", () => {
    const html = render(
      <RecommendationCard rec={{ ...recBase, confidence: 67 }} index={0} />,
    );
    expect(html).toContain('data-confidence-band="medium"');
  });

  it("orange low band + low-confidence caption when value 25-49 and expanded", () => {
    const html = render(
      <RecommendationCard
        rec={{ ...recBase, confidence: 35 }}
        index={0}
        initiallyExpanded
      />,
    );
    expect(html).toContain('data-confidence-band="low"');
    expect(html).toMatch(/Low confidence — based on limited data/);
  });

  it("low-confidence caption is suppressed when meter is high or medium", () => {
    const html = render(
      <RecommendationCard
        rec={{ ...recBase, confidence: 85 }}
        index={0}
        initiallyExpanded
      />,
    );
    expect(html).not.toMatch(/Low confidence/);
  });

  it("draft pill below 25 (rendered by ConfidenceMeter)", () => {
    const html = render(
      <RecommendationCard rec={{ ...recBase, confidence: 15 }} index={0} />,
    );
    expect(html).toContain('data-confidence-band="draft"');
    expect(html).toMatch(/Draft/);
  });

  it("German locale renders translated low-confidence caption", () => {
    const html = render(
      <RecommendationCard
        rec={{ ...recBase, confidence: 35 }}
        index={0}
        initiallyExpanded
      />,
      "de",
    );
    expect(html).toMatch(/Geringes Vertrauen/);
  });

  it("rec-feedback-slot is still rendered (B5e plug-in point intact)", () => {
    const html = render(
      <RecommendationCard
        rec={{ ...recBase, confidence: 85 }}
        index={0}
        initiallyExpanded
      />,
    );
    // The feedback slot itself is present so B5e (or future phases)
    // can plug in. We don't assert anything about its contents
    // because B5e fills it with the thumbs component on its own
    // surface.
    expect(html).toMatch(/data-slot="rec-feedback-slot"/);
  });
});
