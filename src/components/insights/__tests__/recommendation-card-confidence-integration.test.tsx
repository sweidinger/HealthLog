import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/charts/health-chart", () => ({
  HealthChart: () => <div data-testid="health-chart-mock" />,
}));

vi.mock("@/components/charts/mood-chart", () => ({
  MoodChart: () => <div data-testid="mood-chart-mock" />,
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

/**
 * v1.4.16 phase B5d — full-flow integration.
 *
 * MockAIProvider returns a payload where the model claims a high
 * `confidence: 99`. The wrapper MUST overwrite that with the
 * deterministic `computeConfidence()` value, which (with the default
 * resolver: n=9, recencyDays=0, ratio=null) yields:
 *
 *   nScore   = 10 + 10*log10(9) ≈ 19.54
 *   recency  = 30 (recencyDays=0)
 *   signal   = 15 (null)
 *   total    ≈ 64.54 → 65
 *
 * After generation, we mount InsightAdvisorCard with the parsed payload
 * and assert the rendered ConfidenceMeter band corresponds to the
 * server-computed value (medium/yellow), NOT the model's claimed 99
 * (which would have rendered the green high band).
 */

const strictPayloadWithModelConfidence = {
  summary: "BP runs slightly above baseline.",
  recommendations: [
    {
      id: "rec-1",
      text: "Discuss home BP log with your physician.",
      severity: "important",
      // Model claims very high confidence — wrapper overrides.
      confidence: 99,
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

describe("end-to-end — generateInsight() confidence override flows into the card", () => {
  it("renders the deterministic confidence (NOT the model-supplied 99) on the card", async () => {
    const provider = new MockAIProvider({
      responses: JSON.stringify(strictPayloadWithModelConfidence),
    });

    const outcome = await generateInsight(provider, {
      systemPrompt: "system",
      userPrompt: "user",
    });

    const rec = outcome.parsed.recommendations[0];
    // Server-computed value at n=9, recencyDays=0, ratio=null = 65
    expect(rec.confidence).toBe(65);
    expect(rec.confidence).not.toBe(99);

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
        confidence: r.confidence,
      })),
      dataQuality: { coverage: "good", gaps: [], confidence: "hoch" },
      disclaimer: "Not a substitute for medical advice.",
    };

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <InsightAdvisorCard title="Test" insight={insight} />
      </I18nProvider>,
    );

    // Score 65 → medium / yellow band, NOT high / green.
    expect(html).toContain('data-confidence-band="medium"');
    expect(html).not.toContain('data-confidence-band="high"');
    // aria-label must announce the SERVER-computed score, not 99.
    expect(html).toContain('aria-label="Confidence: 65 of 100"');
    expect(html).not.toContain("99 of 100");
  });

  it("falls into the draft band when sample count is too thin (n<3)", async () => {
    const tinyN = {
      ...strictPayloadWithModelConfidence,
      recommendations: [
        {
          ...strictPayloadWithModelConfidence.recommendations[0],
          // Model still claims 99 — wrapper still discards.
          confidence: 99,
          metricSource: {
            ...strictPayloadWithModelConfidence.recommendations[0]
              .metricSource,
            n: 1,
          },
        },
      ],
    };
    const provider = new MockAIProvider({
      responses: JSON.stringify(tinyN),
    });
    const outcome = await generateInsight(provider, {
      systemPrompt: "s",
      userPrompt: "u",
    });

    expect(outcome.parsed.recommendations[0].confidence).toBeLessThanOrEqual(15);

    const insight: InsightResult = {
      insightType: "general",
      summary: "x",
      classification: "gut",
      classificationLabel: "Good",
      findings: [],
      correlations: [],
      recommendations: outcome.parsed.recommendations.map((r) => ({
        text: r.text,
        rationale: r.rationale,
        metricSource: r.metricSource,
        severity: r.severity,
        id: r.id,
        confidence: r.confidence,
      })),
      dataQuality: { coverage: "good", gaps: [], confidence: "gering" },
      disclaimer: "x",
    };

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <InsightAdvisorCard title="Test" insight={insight} />
      </I18nProvider>,
    );

    expect(html).toContain('data-confidence-band="draft"');
    expect(html).toMatch(/Draft/);
  });
});
