import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

// Mirror the message-thread test harness: SSR render with no providers, so
// stub the hooks the bubble reaches for.
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "tester", role: "USER", avatarUrl: null },
    isAuthenticated: true,
    isLoading: false,
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

import { MessageThread, selectCoachChartTokens } from "../message-thread";
import type { CoachConversationDetailDTO } from "@/lib/ai/coach/types";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("selectCoachChartTokens", () => {
  it("returns an allowlisted token grounded in the turn's provenance", () => {
    expect(
      selectCoachChartTokens("The trend metric:WEIGHT is up", ["weight"]),
    ).toEqual(["metric:WEIGHT"]);
  });

  it("drops a token whose metric is not in the grounded provenance", () => {
    expect(selectCoachChartTokens("metric:WEIGHT", [])).toEqual([]);
    expect(selectCoachChartTokens("metric:WEIGHT", ["pulse"])).toEqual([]);
  });

  it("drops a hallucinated / non-allowlisted token", () => {
    expect(selectCoachChartTokens("metric:NUKE", ["weight"])).toEqual([]);
  });

  it("omits synthetic tokens without a self-fetching chart (MOOD)", () => {
    expect(selectCoachChartTokens("metric:MOOD", ["mood"])).toEqual([]);
  });

  it("de-duplicates by metric and caps the number rendered", () => {
    const tokens = selectCoachChartTokens(
      "metric:WEIGHT metric:WEIGHT metric:PULSE metric:BLOOD_GLUCOSE",
      ["weight", "pulse", "glucose"],
    );
    expect(tokens).toEqual(["metric:WEIGHT", "metric:PULSE"]);
  });
});

describe("Coach chart rendering", () => {
  const conversation: CoachConversationDetailDTO = {
    id: "c1",
    title: "Test",
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-01T10:00:00.000Z",
    messageCount: 1,
    messages: [
      {
        id: "m1",
        role: "assistant",
        content: "Your weight is trending down. metric:WEIGHT",
        createdAt: "2026-06-01T10:00:00.000Z",
        metricSource: { windows: ["last30days"], metrics: ["weight"] },
        providerType: "openai",
        promptVersion: null,
        tokensUsed: null,
        model: null,
      },
    ],
  };

  it("mounts a chart for a grounded token and strips it from the prose", () => {
    const html = render(<MessageThread conversation={conversation} />);
    expect(html).toContain('data-slot="coach-charts"');
    expect(html).toContain('data-slot="coach-chart"');
    // The literal token must never surface in the rendered prose.
    expect(html).not.toContain("metric:WEIGHT");
    expect(html).toContain("Your weight is trending down");
  });

  it("renders no chart when the token is not grounded in provenance", () => {
    const ungrounded: CoachConversationDetailDTO = {
      ...conversation,
      messages: [
        {
          ...conversation.messages[0],
          metricSource: { windows: [], metrics: ["pulse"] },
        },
      ],
    };
    const html = render(<MessageThread conversation={ungrounded} />);
    expect(html).not.toContain('data-slot="coach-chart"');
  });
});
