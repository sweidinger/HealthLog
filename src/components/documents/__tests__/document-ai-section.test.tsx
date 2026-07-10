import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { DocumentSuggestionDto } from "@/lib/validations/inbound-documents";
import { DocumentAiSection } from "../document-ai-section";

/**
 * The detail sheet's AI-assist block is availability-gated: with a provider it
 * offers the review-first Suggest / Summarise / Show-text actions; without one
 * the actions collapse to the calm settings pointer (never an action the
 * endpoint would 422). The redundant "read with AI" button + the searchable
 * status pill were removed — reading + indexing happen automatically on upload,
 * so with auto-read ON and no active suggestion/summary the whole block
 * collapses. The summary panel, when open, keeps the session-only note visible.
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
  it("offers the review-first assist actions when a provider is available", () => {
    const html = render(base({ aiEnabled: true }));
    // The standalone "read with AI" button is gone — reading is automatic.
    expect(html).not.toContain('data-slot="document-read-ai"');
    expect(html).toContain('data-slot="assist-suggest"');
    expect(html).toContain("Suggest details");
    expect(html).toContain("Summarise");
    expect(html).toContain("Show extracted text");
    // The searchable status pill was removed from this block.
    expect(html).not.toContain('data-slot="content-search-status"');
    // No unavailable pointer when the actions are offered.
    expect(html).not.toContain('data-slot="assist-unavailable"');
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
  });

  it("renders the transient summary panel", () => {
    const html = render(
      base({
        summaryOutput: "summary",
        summaryResult: { summary: "An MRI report of the left knee." },
      }),
    );
    expect(html).toContain('data-slot="document-summary-panel"');
    expect(html).toContain("An MRI report of the left knee.");
  });

  it("renders no per-document egress notice — the settings confirm covers it", () => {
    // The per-document egress notice was retired; the settings-toggle honesty
    // confirm is now the single place the egress trade is stated.
    const html = render(base({ aiEnabled: true }));
    expect(html).not.toContain('data-slot="document-ai-egress-notice"');
    // The actions are still offered.
    expect(html).toContain('data-slot="assist-suggest"');
  });

  it("collapses the whole block when auto-read is on with nothing to review", () => {
    const html = render(base({ aiEnabled: true, autoReadEnabled: true }));
    // Auto-read reads on upload — the manual per-document actions are gone,
    // and with no active suggestion/summary the block renders nothing at all
    // rather than an empty bordered box.
    expect(html).toBe("");
  });

  it("keeps the review panels when auto-read is on and a suggestion is present", () => {
    const html = render(
      base({
        aiEnabled: true,
        autoReadEnabled: true,
        suggestion,
        suggestionKindLabel: "Imaging",
        suggestionDateLabel: "14 Feb 2026",
      }),
    );
    // The manual action row stays hidden, but the block itself renders to host
    // the review panel.
    expect(html).toContain('data-slot="document-ai-section"');
    expect(html).not.toContain('data-slot="assist-suggest"');
    expect(html).toContain('data-slot="assist-suggestion-review"');
  });

  it("shows the manual AI action row when auto-read is off", () => {
    const html = render(base({ aiEnabled: true, autoReadEnabled: false }));
    expect(html).not.toContain('data-slot="document-read-ai"');
    expect(html).toContain('data-slot="assist-suggest"');
    expect(html).toContain("Summarise");
  });
});
