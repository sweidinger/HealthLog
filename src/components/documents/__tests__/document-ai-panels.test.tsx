import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { DocumentSuggestionDto } from "@/lib/validations/inbound-documents";
import {
  AiUnavailableHint,
  AssistSuggestionReview,
  ContentSearchStatus,
  DocumentSummaryPanel,
} from "../document-ai-panels";

/**
 * The AI panels' render contract:
 *   - the unavailable state is a CALM pointer to the AI settings, never an
 *     error, and adapts its copy to the actionable reason;
 *   - the suggestion card carries the review-first affordance ("review before
 *     saving") and applies nothing on its own — every value has its own tap;
 *   - the summary panel ALWAYS carries the "not saved · not a diagnosis" note,
 *     even while loading, so the session-only contract is never off-screen.
 */

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

const noop = () => {};

const suggestion = (
  overrides: Partial<DocumentSuggestionDto> = {},
): DocumentSuggestionDto => ({
  title: "Blood panel — March 2026",
  kind: "LAB_RESULT",
  documentDate: "2026-03-01",
  ...overrides,
});

describe("<AiUnavailableHint>", () => {
  it("points calmly at the AI settings when no provider is configured", () => {
    const html = render(<AiUnavailableHint reason="no-provider" />);
    expect(html).toContain('data-slot="assist-unavailable"');
    expect(html).toContain('href="/settings/ai"');
    expect(html).toContain("Set up an AI provider");
    // Never an error affordance.
    expect(html).not.toContain('role="alert"');
  });

  it("nudges toward local OCR when a text-only provider needs it", () => {
    const html = render(<AiUnavailableHint reason="enable-local-ocr" />);
    expect(html).toContain("local OCR");
    expect(html).toContain('href="/settings/ai"');
  });
});

describe("<AssistSuggestionReview>", () => {
  it("presents drafts behind an explicit review-before-saving affordance", () => {
    const html = render(
      <AssistSuggestionReview
        suggestion={suggestion()}
        kindLabel="Lab result"
        dateLabel="1 Mar 2026"
        applied={{ title: false, kind: false, date: false }}
        onUseTitle={noop}
        onUseKind={noop}
        onUseDate={noop}
        onDismiss={noop}
      />,
    );
    expect(html).toContain('data-slot="assist-suggestion-review"');
    expect(html).toContain("AI suggestion — review before saving");
    expect(html).toContain("Nothing is saved until you apply it");
    // The suggested values are shown as reviewable drafts.
    expect(html).toContain("Blood panel — March 2026");
    expect(html).toContain("Lab result");
    expect(html).toContain("1 Mar 2026");
    // Each field has an explicit apply control.
    expect(html).toContain("Use title");
    expect(html).toContain("Apply");
  });

  it("marks an applied field instead of re-offering it", () => {
    const html = render(
      <AssistSuggestionReview
        suggestion={suggestion()}
        kindLabel="Lab result"
        dateLabel="1 Mar 2026"
        applied={{ title: true, kind: false, date: false }}
        onUseTitle={noop}
        onUseKind={noop}
        onUseDate={noop}
        onDismiss={noop}
      />,
    );
    expect(html).toContain("Applied");
  });

  it("shows an empty state when nothing could be read", () => {
    const html = render(
      <AssistSuggestionReview
        suggestion={suggestion({ title: null, kind: null, documentDate: null })}
        kindLabel={null}
        dateLabel={null}
        applied={{ title: false, kind: false, date: false }}
        onUseTitle={noop}
        onUseKind={noop}
        onUseDate={noop}
        onDismiss={noop}
      />,
    );
    expect(html).toContain("Nothing could be read from this document");
  });
});

describe("<DocumentSummaryPanel>", () => {
  it("keeps the not-saved / not-a-diagnosis note on screen while loading", () => {
    const html = render(
      <DocumentSummaryPanel
        output="summary"
        result={null}
        isPending
        errorKey={null}
        onClose={noop}
      />,
    );
    expect(html).toContain('data-slot="document-summary-panel"');
    expect(html).toContain('data-slot="document-summary-loading"');
  });

  it("renders the summary body", () => {
    const html = render(
      <DocumentSummaryPanel
        output="summary"
        result={{ summary: "A lipid panel dated 1 March 2026." }}
        isPending={false}
        errorKey={null}
        onClose={noop}
      />,
    );
    expect(html).toContain("A lipid panel dated 1 March 2026.");
  });

  it("renders extracted text in a monospace block", () => {
    const html = render(
      <DocumentSummaryPanel
        output="text"
        result={{ text: "LDL 3.1 mmol/L" }}
        isPending={false}
        errorKey={null}
        onClose={noop}
      />,
    );
    expect(html).toContain("LDL 3.1 mmol/L");
    expect(html).toContain("Extracted text");
    expect(html).toContain("font-mono");
  });

  it("surfaces an error via role=alert", () => {
    const html = render(
      <DocumentSummaryPanel
        output="summary"
        result={null}
        isPending={false}
        errorKey="documents.assist.errorGeneric"
        onClose={noop}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("read the document");
  });
});

describe("<ContentSearchStatus>", () => {
  it("shows a calm not-searchable-yet pill before the auto-index lands", () => {
    const html = render(
      <ContentSearchStatus
        hasContentIndex={false}
        source={null}
        isPending={false}
      />,
    );
    expect(html).toContain('data-slot="content-search-status"');
    expect(html).toContain('data-state="none"');
    expect(html).toContain("Not searchable yet");
    // A status, never a chore button.
    expect(html).not.toContain("<button");
  });

  it("highlights an AI-read document distinctly from a locally-indexed one", () => {
    const aiRead = render(
      <ContentSearchStatus hasContentIndex source="vision" isPending={false} />,
    );
    expect(aiRead).toContain('data-state="ai-read"');
    expect(aiRead).toContain("Read by AI");
    expect(aiRead).toContain("text-primary");

    const local = render(
      <ContentSearchStatus
        hasContentIndex
        source="local-pdf"
        isPending={false}
      />,
    );
    expect(local).toContain('data-state="searchable"');
    expect(local).toContain("Searchable");
    expect(local).not.toContain("Read by AI");
  });

  it("reflects a running read as an indexing state", () => {
    const html = render(
      <ContentSearchStatus hasContentIndex={false} source={null} isPending />,
    );
    expect(html).toContain('data-state="indexing"');
    expect(html).toContain("Making searchable…");
  });
});
