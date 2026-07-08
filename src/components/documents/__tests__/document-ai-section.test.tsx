import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { DocumentSuggestionDto } from "@/lib/validations/inbound-documents";
import { DocumentAiSection } from "../document-ai-section";

/**
 * The detail sheet's AI area is availability-gated: with a provider it shows the
 * assist / summary toolbar; without one it shows ONLY the calm settings pointer
 * (never an action the endpoint would 422). The summary panel, when open, keeps
 * the session-only note visible.
 */

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

const noop = () => {};

const suggestion: DocumentSuggestionDto = {
  title: "MRI knee report",
  kind: "IMAGING",
  documentDate: "2026-02-14",
};

function base(
  overrides: Partial<React.ComponentProps<typeof DocumentAiSection>> = {},
) {
  const props: React.ComponentProps<typeof DocumentAiSection> = {
    aiEnabled: true,
    indexEnabled: true,
    unavailableReason: null,
    egressExternal: false,
    actionsDisabled: false,
    onSuggest: noop,
    suggestPending: false,
    suggestErrorKey: null,
    onSummarise: noop,
    summaryPending: false,
    suggestion: null,
    suggestionKindLabel: null,
    suggestionDateLabel: null,
    appliedFields: { title: false, kind: false, date: false },
    onUseTitle: noop,
    onUseKind: noop,
    onUseDate: noop,
    onDismissSuggestion: noop,
    summaryOutput: null,
    summaryResult: null,
    summaryErrorKey: null,
    onCloseSummary: noop,
    hasContentIndex: false,
    indexPending: false,
    onIndex: noop,
    ...overrides,
  };
  return <DocumentAiSection {...props} />;
}

describe("<DocumentAiSection>", () => {
  it("offers the assist + summary toolbar when a provider is available", () => {
    const html = render(base({ aiEnabled: true }));
    expect(html).toContain('data-slot="assist-suggest"');
    expect(html).toContain("Suggest details");
    expect(html).toContain("Summarise");
    expect(html).toContain("Show extracted text");
    // No unavailable pointer when the affordance is offered.
    expect(html).not.toContain('data-slot="assist-unavailable"');
  });

  it("shows ONLY the calm settings pointer when no provider is available", () => {
    const html = render(
      base({ aiEnabled: false, unavailableReason: "no-provider" }),
    );
    expect(html).toContain('data-slot="assist-unavailable"');
    expect(html).toContain('href="/settings/ai"');
    // The assist / index actions must be absent — never a 422-guaranteed tap.
    expect(html).not.toContain('data-slot="assist-suggest"');
    expect(html).not.toContain('data-slot="content-index-status"');
  });

  it("renders the reviewed suggestion drafts when present", () => {
    const html = render(
      base({
        suggestion,
        suggestionKindLabel: "Imaging",
        suggestionDateLabel: "14 Feb 2026",
      }),
    );
    expect(html).toContain('data-slot="assist-suggestion-review"');
    expect(html).toContain("MRI knee report");
    expect(html).toContain("review before saving");
  });

  it("renders the transient summary panel with the session-only note", () => {
    const html = render(
      base({
        summaryOutput: "summary",
        summaryResult: { summary: "An MRI report of the left knee." },
      }),
    );
    expect(html).toContain('data-slot="document-summary-panel"');
    expect(html).toContain("An MRI report of the left knee.");
    expect(html).toContain("Not saved");
  });

  it("shows the vendor-blind egress notice before an external document read", () => {
    const html = render(base({ aiEnabled: true, egressExternal: true }));
    expect(html).toContain('data-slot="document-ai-egress-notice"');
    expect(html).toContain("third-party AI service");
    // Vendor-blind: never names a specific AI vendor in the document surface.
    expect(html).not.toContain("OpenAI");
    expect(html).not.toContain("ChatGPT");
    // The actions are still offered — the notice informs, it does not block.
    expect(html).toContain('data-slot="assist-suggest"');
  });

  it("omits the egress notice when the read stays on the local machine", () => {
    const html = render(base({ aiEnabled: true, egressExternal: false }));
    expect(html).not.toContain('data-slot="document-ai-egress-notice"');
  });

  it("hides the content-index row when indexing is unavailable", () => {
    const html = render(base({ aiEnabled: true, indexEnabled: false }));
    expect(html).toContain('data-slot="assist-suggest"');
    expect(html).not.toContain('data-slot="content-index-status"');
  });
});
