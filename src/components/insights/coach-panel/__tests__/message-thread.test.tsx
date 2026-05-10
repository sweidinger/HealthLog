import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { MessageThread } from "../message-thread";
import type { CoachConversationDetailDTO } from "@/lib/ai/coach/types";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const baseConversation: CoachConversationDetailDTO = {
  id: "conv-1",
  title: "Why was BP higher on Monday?",
  createdAt: "2026-05-10T09:00:00.000Z",
  updatedAt: "2026-05-10T09:01:00.000Z",
  messageCount: 2,
  messages: [
    {
      id: "m1",
      role: "user",
      content: "Why was BP higher on Monday?",
      createdAt: "2026-05-10T09:00:00.000Z",
      metricSource: null,
      providerType: null,
      promptVersion: null,
    },
    {
      id: "m2",
      role: "assistant",
      content: "Looking at your last 6 Mondays, the morning systolic averaged …",
      createdAt: "2026-05-10T09:00:30.000Z",
      metricSource: {
        windows: ["last30days"],
        metrics: ["bp"],
        counts: { bp: 26 },
      },
      providerType: "admin-openai",
      promptVersion: "4.20.0",
    },
  ],
};

describe("<MessageThread>", () => {
  it("shows the empty hint when no conversation and no streaming", () => {
    const html = render(<MessageThread conversation={null} />);
    expect(html).toContain('data-slot="coach-message-thread"');
    expect(html).toContain(
      "Ask anything about your trends, medications, or readings",
    );
  });

  it("renders user + assistant bubbles for a persisted conversation", () => {
    const html = render(<MessageThread conversation={baseConversation} />);
    expect(html).toContain('data-slot="coach-bubble-user"');
    expect(html).toContain('data-slot="coach-bubble-assistant"');
    expect(html).toContain("Why was BP higher on Monday?");
    expect(html).toContain(
      "Looking at your last 6 Mondays, the morning systolic averaged",
    );
  });

  it("renders source chips below an assistant bubble that carries provenance", () => {
    const html = render(<MessageThread conversation={baseConversation} />);
    expect(html).toContain('data-slot="coach-source-chips"');
    expect(html).toContain('data-metric="bp"');
    expect(html).toContain("last 30 days");
    expect(html).toContain("n=26");
  });

  it("renders an in-flight streaming bubble alongside persisted history", () => {
    const html = render(
      <MessageThread
        conversation={baseConversation}
        streaming={{
          content: "Looking at your data ",
          metricSource: null,
          inProgress: true,
          messageId: null,
          errorCode: null,
        }}
      />,
    );
    // 1 persisted user + 1 persisted assistant + 1 streaming assistant.
    const userBubbles = (
      html.match(/data-slot="coach-bubble-user"/g) ?? []
    ).length;
    const assistantBubbles = (
      html.match(/data-slot="coach-bubble-assistant"/g) ?? []
    ).length;
    expect(userBubbles).toBe(1);
    expect(assistantBubbles).toBe(2);
    expect(html).toContain("Looking at your data");
  });

  it("shows the streaming-only bubble when no conversation is loaded yet", () => {
    const html = render(
      <MessageThread
        conversation={null}
        streaming={{
          content: "Drafting…",
          metricSource: null,
          inProgress: true,
          messageId: null,
          errorCode: null,
        }}
      />,
    );
    expect(html).toContain("Drafting…");
    expect(html).toContain('data-slot="coach-bubble-assistant"');
  });

  it("renders the 'thinking' placeholder when content is empty but inProgress", () => {
    const html = render(
      <MessageThread
        conversation={null}
        streaming={{
          content: "",
          metricSource: null,
          inProgress: true,
          messageId: null,
          errorCode: null,
        }}
      />,
    );
    expect(html).toContain("Thinking");
  });

  it("surfaces the provider error copy when an error frame fired", () => {
    const html = render(
      <MessageThread
        conversation={null}
        streaming={{
          content: "",
          metricSource: null,
          inProgress: false,
          messageId: null,
          errorCode: "errorProvider",
        }}
      />,
    );
    expect(html).toContain("could not reach an AI provider");
  });

  it("uses German empty hint when locale is 'de'", () => {
    const html = render(<MessageThread conversation={null} />, "de");
    expect(html).toContain(
      "Frag mich etwas zu deinen Trends, Medikamenten oder Messwerten",
    );
  });
});
