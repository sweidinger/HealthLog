import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/charts/health-chart", () => ({
  HealthChart: ({
    types,
    title,
    mini,
    windowOverride,
  }: {
    types: string[];
    title: string;
    mini?: boolean;
    windowOverride?: string;
  }) => (
    <div
      data-testid="health-chart-mock"
      data-types={types.join(",")}
      data-mini={mini ? "true" : "false"}
      data-window={windowOverride ?? ""}
    >
      chart:{title}
    </div>
  ),
}));

vi.mock("@/components/charts/mood-chart", () => ({
  MoodChart: ({ mini }: { mini?: boolean }) => (
    <div data-testid="mood-chart-mock" data-mini={mini ? "true" : "false"} />
  ),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: null, isLoading: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { InsightAdvisorCard } from "../insight-advisor-card";
import type { InsightResult } from "@/lib/ai/types";
import { generateInsight } from "@/lib/ai/generate-insight";
import { MockAIProvider } from "@/lib/ai/mock-client";
import { MEDICAL_REFERENCES } from "@/lib/ai/medical-references";

/**
 * v1.4.16 phase B5c — full-flow integration.
 *
 * Mocks an AIProvider that returns a structured payload with
 * rationale on every rec, runs `generateInsight()` to validate +
 * parse, then feeds the parsed payload through InsightAdvisorCard.
 * Asserts the advisor card surfaces the rec text + rationale rows
 * via the RecommendationCard subcomponent.
 *
 * The advisor card consumes the legacy `InsightResult` shape, not
 * the strict `AIInsightResponse` — but the new field schema is
 * optional on the UI type, so a recommendation flowing in as a
 * structured object with rationale renders the expand-card.
 */

const knownRefId = MEDICAL_REFERENCES[0].id;

const strictPayload = {
  summary: "Your blood pressure is elevated against your own baseline.",
  recommendations: [
    {
      id: "rec-1",
      text: "Discuss home BP log with your physician.",
      severity: "important",
      metricSource: {
        type: "bloodPressure",
        timeRange: "last7days",
        summary: "avg 138/86 across 9 readings",
        n: 9,
      },
      rationale: {
        dataWindow: "last7days",
        comparedTo: "your 90-day median (122/78)",
        deviation: "+16/+8 mmHg above baseline over 9 of 9 readings",
      },
      referenceId: knownRefId,
    },
  ],
  citations: [
    {
      type: "bloodPressure",
      timeRange: "last7days",
      summary: "avg 138/86 across 9 readings",
    },
  ],
  warnings: [],
};

describe("end-to-end — generateInsight() + RecommendationCard render", () => {
  it("strict payload from MockAIProvider passes parse + flows through to RecommendationCard rationale rows", async () => {
    const provider = new MockAIProvider({
      responses: JSON.stringify(strictPayload),
    });

    const outcome = await generateInsight(provider, {
      systemPrompt: "system",
      userPrompt: "user",
    });

    expect(outcome.parsed.recommendations).toHaveLength(1);
    const rec = outcome.parsed.recommendations[0];
    expect(rec.rationale).toEqual({
      dataWindow: "last7days",
      comparedTo: "your 90-day median (122/78)",
      deviation: "+16/+8 mmHg above baseline over 9 of 9 readings",
    });

    // Wrap as an InsightResult (legacy UI-shape) — only the
    // recommendations need to carry the new fields for the rec card
    // to render the expand panel.
    const insight: InsightResult = {
      insightType: "general",
      summary: outcome.parsed.summary,
      classification: "grenzwertig",
      classificationLabel: "Borderline",
      findings: [],
      correlations: [],
      recommendations: outcome.parsed.recommendations.map((r) => ({
        text: r.text,
        referenceId: r.referenceId,
        rationale: r.rationale,
        metricSource: r.metricSource,
        severity: r.severity,
        id: r.id,
      })),
      dataQuality: { coverage: "good", gaps: [], confidence: "hoch" },
      disclaimer: "Not a substitute for medical advice.",
    };

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <InsightAdvisorCard
          title="Test"
          insight={insight}
          legacyPayload={false}
        />
      </I18nProvider>,
    );

    // The rec card is collapsed by default — assert chevron present.
    expect(html).toContain("Discuss home BP log");
    expect(html).toMatch(/aria-expanded="false"/);
    // Severity badge
    expect(html).toContain("important");
  });

  it("legacyPayload flag surfaces the regenerate CTA", () => {
    const insight: InsightResult = {
      insightType: "general",
      summary: "x",
      classification: "gut",
      classificationLabel: "Good",
      findings: [],
      correlations: [],
      recommendations: ["Plain string rec"],
      dataQuality: { coverage: "good", gaps: [], confidence: "hoch" },
      disclaimer: "Disclaimer",
    };

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <InsightAdvisorCard
          title="Test"
          insight={insight}
          legacyPayload
          onRegenerate={() => {}}
        />
      </I18nProvider>,
    );

    expect(html).toContain('data-slot="insight-legacy-payload-cta"');
    expect(html).toContain("Insights updated");
  });
});
