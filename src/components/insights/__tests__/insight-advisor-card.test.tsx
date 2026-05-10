import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// HealthChart pulls in TanStack Query + recharts. We don't care about its
// internal rendering — we only need to know *that it was rendered* and
// with which `types[]` (which is the chart's metric handle, since the
// real component takes `types: string[]` not `metric: string`).
vi.mock("@/components/charts/health-chart", () => ({
  HealthChart: ({ types, title }: { types: string[]; title: string }) => (
    <div data-testid="health-chart" data-types={types.join(",")}>
      chart:{title}
    </div>
  ),
}));

// Stub TanStack Query — InsightAdvisorCard itself doesn't query, but
// nested clients (and the HealthChart mock above replaces the real one)
// pull from this. Safe no-op.
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

import { I18nProvider } from "@/lib/i18n/context";
import { InsightAdvisorCard } from "../insight-advisor-card";
import type { InsightResult } from "@/lib/ai/types";

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

function render(insight: InsightResult) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <InsightAdvisorCard title="Test card" insight={insight} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<InsightAdvisorCard> — inline chart tokens", () => {
  it("renders an inline HealthChart for an allowlisted token in summary", () => {
    const html = render(
      buildInsight({
        summary: "BP looking great metric:BLOOD_PRESSURE_SYS today",
      }),
    );

    // Chart is rendered with the token's metric as the type.
    expect(html).toContain('data-testid="health-chart"');
    expect(html).toContain('data-types="BLOOD_PRESSURE_SYS"');

    // Token literal is stripped from the visible prose.
    expect(html).not.toContain("metric:BLOOD_PRESSURE_SYS");

    // Surrounding prose survives unchanged.
    expect(html).toContain("BP looking great");
    expect(html).toContain("today");
  });

  it("drops hallucinated tokens silently and still strips the literal", () => {
    const html = render(
      buildInsight({
        summary: "metric:NUKE try this",
      }),
    );

    // No chart rendered.
    expect(html).not.toContain('data-testid="health-chart"');

    // Token literal is gone from the DOM.
    expect(html).not.toContain("metric:NUKE");

    // Visible text is the surrounding prose only.
    expect(html).toContain("try this");
  });

  it("treats injection attempts as plain text — no script, no markup", () => {
    const html = render(
      buildInsight({
        summary: "metric:WEIGHT' onclick='alert(1)'",
      }),
    );

    // The chart still renders for the safe metric prefix.
    expect(html).toContain('data-testid="health-chart"');
    expect(html).toContain('data-types="WEIGHT"');

    // The trailing junk is preserved as escaped text — no script tag,
    // no live `onclick` attribute survives the React text path.
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<[^>]*\sonclick\s*=/i);

    // The escaped remnant still appears in the prose so the user can see
    // what the model emitted (alert(1) is now inert HTML-encoded text).
    expect(html).toContain("alert(1)");
  });

  it("renders an inline chart attached to a hero finding token", () => {
    const html = render(
      buildInsight({
        findings: [
          {
            label: "Pulse trending down metric:PULSE",
            value: "68 bpm",
            assessment: "positive",
          },
        ],
      }),
    );

    expect(html).toContain('data-types="PULSE"');
    expect(html).not.toContain("metric:PULSE");
    expect(html).toContain("Pulse trending down");
  });

  it("renders inline charts for secondary findings without leaking tokens", () => {
    const html = render(
      buildInsight({
        findings: [
          {
            label: "Hero finding",
            value: "120/80",
            assessment: "neutral",
          },
          {
            label: "Weight stable metric:WEIGHT",
            value: "82 kg",
            assessment: "positive",
          },
        ],
      }),
    );

    expect(html).toContain('data-types="WEIGHT"');
    expect(html).not.toContain("metric:WEIGHT");
    expect(html).toContain("Weight stable");
  });
});

describe("<InsightAdvisorCard> — summary typography polish (B1b)", () => {
  it("paints the summary slot with a constrained max-width for readability", () => {
    const html = render(
      buildInsight({
        summary: "Your BP averaged 132/84 over the last 30 days.",
      }),
    );
    expect(html).toMatch(/data-slot="insight-summary"/);
    // The summary slot carries a Tailwind max-w-* class so prose
    // doesn't stretch full-bleed on a wide viewport.
    expect(html).toMatch(/max-w-(prose|2xl|3xl)/);
  });

  it("uses the polished prose typography (text-base, leading-relaxed)", () => {
    const html = render(
      buildInsight({
        summary: "All metrics within target.",
      }),
    );
    // A larger font + relaxed line-height for the page-anchored
    // summary; the per-card content uses text-sm.
    expect(html).toMatch(
      /data-slot="insight-summary"[^>]*class="[^"]*text-base/,
    );
    expect(html).toMatch(
      /data-slot="insight-summary"[^>]*class="[^"]*leading-relaxed/,
    );
  });

  it("renders summary inline charts as mini sparklines (data-mini=true)", () => {
    const html = render(
      buildInsight({
        summary: "BP averaging 132/84 metric:BLOOD_PRESSURE_SYS today",
      }),
    );
    // The summary's inline-chart wrapper must carry `data-mini="true"`
    // so the chart shrinks to sparkline form. Per-finding charts use
    // the default detail mode.
    expect(html).toMatch(/data-slot="insight-summary"[\s\S]*?data-mini="true"/);
  });
});

describe("<InsightAdvisorCard> — polished loading / empty / error states (B1b)", () => {
  it("loading state shows a skeleton that mirrors the final layout", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <InsightAdvisorCard title="Loading test" insight={null} loading />
      </I18nProvider>,
    );
    // A discoverable skeleton slot replaces the spinner-only loading state.
    expect(html).toMatch(/data-slot="insight-skeleton"/);
    // 3 placeholder rec rows match the final card grid (so the page
    // doesn't visually jump when content lands).
    expect(html).toMatch(/data-slot="insight-skeleton-card"/);
  });

  it("empty state shows a friendly illustration + CTA", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <InsightAdvisorCard
          title="Empty test"
          insight={null}
          onRegenerate={() => {}}
        />
      </I18nProvider>,
    );
    expect(html).toMatch(/data-slot="insight-empty-state"/);
    // The Start-Analysis button stays — that's the CTA.
    expect(html).toContain("Start analysis");
  });

  it("error state surfaces a retry button when onRegenerate is provided", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <InsightAdvisorCard
          title="Error test"
          insight={null}
          error="Something went wrong"
          onRegenerate={() => {}}
        />
      </I18nProvider>,
    );
    expect(html).toMatch(/data-slot="insight-error-state"/);
    expect(html).toContain("Something went wrong");
    expect(html).toMatch(/data-slot="insight-retry-button"/);
  });

  it("renders the legacy v1.4.14 payload without crashing (regenerate CTA)", () => {
    // Reproduces the maintainer's production /insights crash on 2026-05-10:
    //
    //   TypeError: Cannot read properties of undefined (reading 'replace')
    //     at stripChartTokens(insight.summary)
    //
    // The cached blob in the DB predates v1.4.16's strict insight schema
    // (no `summary`, no `recommendations[]`, no `findings[]`, no
    // `dataQuality`, no `disclaimer` — it carries the old `changed`,
    // `stable`, `drivers`, `nextSteps`, `confidence`, `limitations`
    // shape). The route's `safeParse(parsed)` fails and falls through
    // to `insights = parsed`, so the legacy blob reaches the card with
    // `summary === undefined`. The card must surface a regenerate CTA
    // and skip rendering the prose, NOT crash.
    const legacy = {
      changed: "Long-term improvement on weight and BP.",
      stable: "Pulse remains stable.",
      drivers: "Weight reduction may have contributed.",
      nextSteps: "Keep going.",
      confidence: "hoch",
      limitations: "Correlations don't imply causation.",
    } as unknown as InsightResult;

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <InsightAdvisorCard
          title="Test card"
          insight={legacy}
          legacyPayload
          onRegenerate={() => {}}
        />
      </I18nProvider>,
    );

    // No crash means the test got here. Surface the regenerate CTA so
    // the user has a one-click escape from the legacy state.
    expect(html).toContain('data-slot="insight-legacy-payload-cta"');
    // F-06 (v1.4.19): the CTA copy says "regenerate", so the button
    // label must say "Regenerate" too — not "Start analysis".
    expect(html).toContain("Regenerate");
  });

  it("error state without onRegenerate hides the retry button", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <InsightAdvisorCard
          title="Error test"
          insight={null}
          error="No retry available"
        />
      </I18nProvider>,
    );
    expect(html).toContain("No retry available");
    expect(html).not.toContain('data-slot="insight-retry-button"');
  });
});
