import { describe, it, expect, vi } from "vitest";
import { createContext } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/context";
import { RecommendationCard } from "../recommendation-card";
import { MEDICAL_REFERENCES } from "@/lib/ai/medical-references";

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

// v1.18.11 (W5 perf) — the rationale charts now route through `next/dynamic`
// so recharts is off the insights first-load JS. Under `renderToStaticMarkup`
// a `dynamic(..., { ssr:false })` boundary paints its loading skeleton (it
// never resolves the lazy chunk synchronously). For the chart-SELECTION
// assertions below we stub `next/dynamic` to a passthrough that renders the
// (already-mocked) underlying chart component eagerly, so the test still
// verifies the card picks the right chart kind for a metric. Production keeps
// the real lazy boundary + skeleton.
vi.mock("next/dynamic", async () => {
  const health = await import("@/components/charts/health-chart");
  const mood = await import("@/components/charts/mood-chart");
  return {
    default: (loader: unknown) => {
      // Identify which chart the loader targets by its source text.
      const src = String(loader);
      const Comp = (
        src.includes("mood-chart") ? mood.MoodChart : health.HealthChart
      ) as React.ComponentType<Record<string, unknown>>;
      return (props: Record<string, unknown>) => <Comp {...props} />;
    },
  };
});

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
  // v1.21.0 — the card's footer `<AskCoachAction>` reaches the
  // query-client mount probe (`useFeatureFlags` / `useDisableCoach`); the
  // probe only needs the context to exist. A null-default context reads
  // as "no client mounted" so both hooks return their fail-open defaults.
  QueryClientContext: createContext(null),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "test-user", username: "tester", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

const knownRef = MEDICAL_REFERENCES[0];

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

/**
 * v1.4.16 phase B5c — Oura-style RecommendationCard.
 *
 * Each rec collapses into a one-row summary (text + severity + chevron
 * + named slots for confidence ring (B5d) + feedback thumbs (B5e)).
 * Expanding reveals the rationale 3-row card + mini-chart pinned to
 * the rec's data window + the citation footnote (B5a).
 *
 * Default: collapsed. The chevron toggles aria-expanded.
 */

describe("<RecommendationCard>", () => {
  it("renders the rec text and severity badge in collapsed state", () => {
    const html = render(<RecommendationCard rec={recBase} index={0} />);
    expect(html).toContain("Discuss home BP log");
    // The expand button has aria-expanded="false" when collapsed.
    expect(html).toMatch(/aria-expanded="false"/);
  });

  it("renders rationale rows when initially expanded", () => {
    const html = render(
      <RecommendationCard rec={recBase} index={0} initiallyExpanded />,
    );
    // All 3 row labels visible (English locale)
    expect(html).toContain("Window");
    expect(html).toContain("Compared to");
    expect(html).toContain("Deviation");
    // Values rendered verbatim
    expect(html).toContain("last7days");
    expect(html).toContain("your 90-day median (122/78)");
    expect(html).toContain("+16/+8 mmHg above baseline");
    // aria-expanded flips to true
    expect(html).toMatch(/aria-expanded="true"/);
  });

  it("renders the mini-chart pinned to the rec's data window when expanded", () => {
    const html = render(
      <RecommendationCard rec={recBase} index={0} initiallyExpanded />,
    );
    expect(html).toContain('data-testid="health-chart-mock"');
    expect(html).toContain('data-mini="true"');
    expect(html).toContain('data-window="last7days"');
  });

  it("does NOT render the rationale block when collapsed (default)", () => {
    const html = render(<RecommendationCard rec={recBase} index={0} />);
    expect(html).not.toContain("Window");
    expect(html).not.toContain("your 90-day median (122/78)");
    expect(html).not.toContain('data-testid="health-chart-mock"');
  });

  it("renders the citation footnote when referenceId resolves and expanded", () => {
    const html = render(
      <RecommendationCard
        rec={{ ...recBase, referenceId: knownRef.id }}
        index={0}
        initiallyExpanded
      />,
    );
    expect(html).toContain(knownRef.url);
    expect(html).toContain('data-slot="insight-recommendation-source"');
  });

  it("does not render rationale block when rec lacks rationale (legacy migration grace)", () => {
    const legacyRec = {
      id: "rec-old",
      text: "Walk more",
      severity: "suggestion" as const,
    };
    const html = render(
      <RecommendationCard rec={legacyRec} index={0} initiallyExpanded />,
    );
    expect(html).toContain("Walk more");
    // No rationale labels
    expect(html).not.toContain("Window");
    expect(html).not.toContain("Compared to");
    // No expand control either since there's nothing to expand to
    expect(html).not.toMatch(/aria-expanded=/);
  });

  it("treats a plain-string rec as legacy (no expand chevron)", () => {
    const html = render(
      <RecommendationCard rec="Continue daily logging." index={0} />,
    );
    expect(html).toContain("Continue daily logging.");
    expect(html).not.toMatch(/aria-expanded=/);
  });

  it("German locale labels — rationale rows translate", () => {
    const html = render(
      <RecommendationCard rec={recBase} index={0} initiallyExpanded />,
      "de",
    );
    expect(html).toContain("Fenster");
    expect(html).toContain("Verglichen mit");
    expect(html).toContain("Abweichung");
  });

  it("renders named slots for confidence (B5d) and feedback (B5e) so future phases can plug in", () => {
    const html = render(<RecommendationCard rec={recBase} index={0} />);
    // Slot for confidence ring — B5d will fill this.
    expect(html).toMatch(/data-slot="rec-confidence-slot"/);
    // Slot for feedback thumbs — B5e will fill this. The slot lives
    // inside the expanded card, so wrap with initiallyExpanded.
    const expanded = render(
      <RecommendationCard rec={recBase} index={0} initiallyExpanded />,
    );
    expect(expanded).toMatch(/data-slot="rec-feedback-slot"/);
  });

  it("maps metricSource.type to the chart's metric handle (BP_SYS for bloodPressure)", () => {
    const html = render(
      <RecommendationCard rec={recBase} index={0} initiallyExpanded />,
    );
    // The chart mock echoes its `types` prop. bloodPressure → both
    // sys + dia (we render both lines on the same mini-chart).
    expect(html).toMatch(/data-types="BLOOD_PRESSURE_SYS,BLOOD_PRESSURE_DIA"/);
  });

  it("maps metricSource.type=mood to the MoodChart, also mini", () => {
    const moodRec = {
      ...recBase,
      metricSource: {
        type: "mood",
        timeRange: "last7days",
        summary: "5/5 logs",
      },
    };
    const html = render(
      <RecommendationCard rec={moodRec} index={0} initiallyExpanded />,
    );
    expect(html).toContain('data-testid="mood-chart-mock"');
    expect(html).toContain('data-mini="true"');
  });

  // ── v1.4.16 phase B5e — feedback wiring ───────────────────────
  // Verifies B5c's named slot is now filled by RecommendationFeedback
  // when the rec carries every attribute the feedback API requires.
  it("wires the feedback thumbs into the expanded rationale card when fully attributed", () => {
    const html = render(
      <RecommendationCard rec={recBase} index={0} initiallyExpanded />,
    );
    expect(html).toContain('data-feedback-thumb="up"');
    expect(html).toContain('data-feedback-thumb="down"');
  });

  it("does NOT render feedback thumbs when the rec lacks an id (defence-in-depth)", () => {
    const recNoId = { ...recBase, id: undefined };
    const html = render(
      <RecommendationCard rec={recNoId} index={0} initiallyExpanded />,
    );
    expect(html).not.toContain("data-feedback-thumb=");
  });

  it("does NOT render feedback thumbs when the metricSource.timeRange is out of vocabulary", () => {
    const recBadWindow = {
      ...recBase,
      metricSource: { ...recBase.metricSource, timeRange: "lastFortnight" },
    };
    const html = render(
      <RecommendationCard rec={recBadWindow} index={0} initiallyExpanded />,
    );
    expect(html).not.toContain("data-feedback-thumb=");
  });

  /**
   * v1.4.22 A6 — strip chart-tokens from the always-visible
   * recommendation text. W1a §3 traced the production "metric:WEIGHT"
   * leak the maintainer saw at the bottom of the advisor card to this exact
   * render path: every other AI-prose surface ran through
   * `stripChartTokens()`, the recommendation text didn't. Pin the
   * strip so a future copy-paste regression can't reintroduce the
   * leak.
   */
  it("strips literal chart tokens (metric:WEIGHT et al) from the rec text", () => {
    const recWithToken = {
      ...recBase,
      text: "Increase fluids. metric:WEIGHT",
    };
    const html = render(<RecommendationCard rec={recWithToken} index={0} />);
    expect(html).not.toContain("metric:WEIGHT");
    expect(html).toContain("Increase fluids.");
  });

  it("strips lowercase / mixed-case model output from the rec text", () => {
    const recWithLowercaseToken = {
      ...recBase,
      text: "Watch the trend. metric:blood_pressure_sys today",
    };
    const html = render(
      <RecommendationCard rec={recWithLowercaseToken} index={0} />,
    );
    expect(html).not.toContain("metric:blood_pressure_sys");
    expect(html).toContain("Watch the trend.");
    expect(html).toContain("today");
  });
});
