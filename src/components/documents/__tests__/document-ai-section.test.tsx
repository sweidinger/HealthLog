import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { DocumentSuggestionDto } from "@/lib/validations/inbound-documents";
import { DocumentAiSection } from "../document-ai-section";

/**
 * The detail sheet's "Read with AI" block is availability-gated: with a provider
 * it offers the prominent "Read with AI" action alongside suggest / summary;
 * without one the actions collapse to the calm settings pointer (never an action
 * the endpoint would 422). The searchable status pill reflects the auto-index in
 * both states. The summary panel, when open, keeps the session-only note visible.
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
    contentIndexSource: null,
    indexPending: false,
    onIndex: noop,
    ...overrides,
  };
  return <DocumentAiSection {...props} />;
}

describe("<DocumentAiSection>", () => {
  it("leads with the prominent Read-with-AI action when a provider is available", () => {
    const html = render(base({ aiEnabled: true }));
    expect(html).toContain('data-slot="document-read-ai"');
    expect(html).toContain("Read with AI");
    expect(html).toContain('data-slot="assist-suggest"');
    expect(html).toContain("Suggest details");
    expect(html).toContain("Summarise");
    expect(html).toContain("Show extracted text");
    // No unavailable pointer when the actions are offered.
    expect(html).not.toContain('data-slot="assist-unavailable"');
  });

  it("labels the action as a re-read once a provider has already read it", () => {
    const html = render(
      base({ hasContentIndex: true, contentIndexSource: "vision" }),
    );
    expect(html).toContain('data-slot="document-read-ai"');
    expect(html).toContain("Read again");
    // The status pill reflects the AI-read provenance.
    expect(html).toContain('data-state="ai-read"');
    expect(html).toContain("Read by AI");
  });

  it("shows the calm settings pointer (no 422 actions) when no provider is available", () => {
    const html = render(
      base({
        aiEnabled: false,
        indexEnabled: false,
        unavailableReason: "no-provider",
      }),
    );
    expect(html).toContain('data-slot="assist-unavailable"');
    expect(html).toContain('href="/settings/ai"');
    // Every AI action must be absent — never a 422-guaranteed tap.
    expect(html).not.toContain('data-slot="assist-suggest"');
    expect(html).not.toContain('data-slot="document-read-ai"');
    // But the searchable status pill still renders — auto-index is honest here.
    expect(html).toContain('data-slot="content-search-status"');
  });

  it("keeps a locally-indexed document honestly searchable without a provider", () => {
    const html = render(
      base({
        aiEnabled: false,
        indexEnabled: false,
        unavailableReason: "no-provider",
        hasContentIndex: true,
        contentIndexSource: "local-pdf",
      }),
    );
    expect(html).toContain('data-state="searchable"');
    expect(html).toContain("Searchable");
    expect(html).not.toContain("Read by AI");
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

  it("hides the Read-with-AI action when indexing is unavailable but keeps suggest", () => {
    const html = render(base({ aiEnabled: true, indexEnabled: false }));
    expect(html).toContain('data-slot="assist-suggest"');
    expect(html).not.toContain('data-slot="document-read-ai"');
  });
});
