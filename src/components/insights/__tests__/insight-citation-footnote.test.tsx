import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// HealthChart pulls in TanStack Query + recharts. Stub it for the
// same reasons the sibling card test does.
vi.mock("@/components/charts/health-chart", () => ({
  HealthChart: ({ types, title }: { types: string[]; title: string }) => (
    <div data-testid="health-chart" data-types={types.join(",")}>
      chart:{title}
    </div>
  ),
}));

vi.mock("@/components/charts/mood-chart", () => ({
  MoodChart: () => <div data-testid="mood-chart" />,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: null, isLoading: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { InsightAdvisorCard } from "../insight-advisor-card";
import type { InsightResult } from "@/lib/ai/types";
import { MEDICAL_REFERENCES } from "@/lib/ai/medical-references";

const knownRef = MEDICAL_REFERENCES[0];

function buildInsight(overrides: Partial<InsightResult> = {}): InsightResult {
  return {
    insightType: "general",
    summary: "All good",
    classification: "gut",
    classificationLabel: "Good",
    findings: [
      {
        label: "Heart rate stable",
        value: "72 bpm",
        assessment: "positive",
      },
    ],
    correlations: [],
    primaryRecommendation: "Keep going",
    recommendations: [],
    dataQuality: {
      coverage: "good",
      gaps: [],
      confidence: "hoch",
    },
    disclaimer: "Not a substitute for medical advice.",
    ...overrides,
  };
}

function render(insight: InsightResult, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <InsightAdvisorCard title="Test card" insight={insight} />
    </I18nProvider>,
  );
}

describe("<InsightAdvisorCard> — recommendation citation footnote (B5a)", () => {
  it("renders no footnote for legacy string recommendations", () => {
    const html = render(
      buildInsight({
        recommendations: ["Continue daily logging."],
      }),
    );
    expect(html).toContain("Continue daily logging.");
    expect(html).not.toContain('data-slot="insight-recommendation-source"');
    expect(html).not.toContain("Source:");
  });

  it("renders no footnote for structured rec WITHOUT a referenceId", () => {
    const html = render(
      buildInsight({
        recommendations: [{ text: "Keep an eye on your sleep." }],
      }),
    );
    expect(html).toContain("Keep an eye on your sleep.");
    expect(html).not.toContain('data-slot="insight-recommendation-source"');
  });

  it("renders the footnote with EN title + URL when referenceId resolves", () => {
    const html = render(
      buildInsight({
        recommendations: [
          {
            text: "Aim for a target below 140/90.",
            referenceId: knownRef.id,
          },
        ],
      }),
      "en",
    );
    expect(html).toContain('data-slot="insight-recommendation-source"');
    expect(html).toContain(`data-reference-id="${knownRef.id}"`);
    expect(html).toContain(knownRef.title);
    expect(html).toContain(`${knownRef.publishedYear}`);
    expect(html).toContain(knownRef.org);
    expect(html).toContain(`href="${knownRef.url}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain("Source:");
  });

  it("renders the German title under de locale", () => {
    const html = render(
      buildInsight({
        recommendations: [
          {
            text: "Aim for a target below 140/90.",
            referenceId: knownRef.id,
          },
        ],
      }),
      "de",
    );
    expect(html).toContain(knownRef.titleDe);
    // German "Source" label
    expect(html).toContain("Quelle:");
  });

  it("silently drops the footnote for an unknown referenceId (defence in depth)", () => {
    // The schema would normally reject this payload, but if a stale
    // payload sneaks through, the UI must not render a broken link.
    const html = render(
      buildInsight({
        recommendations: [
          {
            text: "Aim for something.",
            referenceId: "fabricated-2099",
          },
        ],
      }),
    );
    expect(html).toContain("Aim for something.");
    expect(html).not.toContain('data-slot="insight-recommendation-source"');
    expect(html).not.toContain("Source:");
  });

  it("renders multiple recs, each with their own footnote when applicable", () => {
    const second = MEDICAL_REFERENCES[1] ?? knownRef;
    const html = render(
      buildInsight({
        recommendations: [
          { text: "First rec", referenceId: knownRef.id },
          { text: "Second rec", referenceId: second.id },
          "Third plain rec",
        ],
      }),
    );
    expect(html).toContain("First rec");
    expect(html).toContain("Second rec");
    expect(html).toContain("Third plain rec");
    expect(html).toContain(knownRef.url);
    if (second !== knownRef) expect(html).toContain(second.url);
    // The plain string rec produces no footnote.
    const matches = html.match(/data-slot="insight-recommendation-source"/g);
    expect(matches?.length ?? 0).toBe(second !== knownRef ? 2 : 2);
  });
});
