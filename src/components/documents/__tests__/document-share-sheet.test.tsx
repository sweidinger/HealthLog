import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The document-launched share sheet now accepts an ARRAY of documents so the
 * bulk multi-select can fold the whole selection into ONE documents-only link.
 * The single-doc (detail sheet) caller passes a one-element array.
 *
 * ResponsiveSheet wraps its body in a Radix portal that renderToStaticMarkup
 * won't materialise, so both it and the create form are mocked down to plain
 * wrappers that surface the title + the seeded form props.
 */
vi.mock("@/components/ui/responsive-sheet", () => ({
  ResponsiveSheet: ({
    title,
    children,
  }: {
    title: React.ReactNode;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <div data-slot="mock-responsive-sheet">
      <div data-slot="sheet-title">{title}</div>
      {children}
    </div>
  ),
}));

vi.mock("@/components/settings/share-link-create-form", () => ({
  ShareLinkCreateForm: (props: {
    documentOnly?: boolean;
    initialDocuments?: { id: string; title: string }[];
    initialLabel?: string;
  }) => (
    <div
      data-slot="mock-share-form"
      data-document-only={String(props.documentOnly ?? false)}
      data-initial-label={props.initialLabel ?? ""}
      data-doc-ids={(props.initialDocuments ?? []).map((d) => d.id).join(",")}
      data-doc-count={String((props.initialDocuments ?? []).length)}
    />
  ),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { DocumentShareSheet } from "../document-share-sheet";

function render(documents: { id: string; title: string }[]) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <DocumentShareSheet open onOpenChange={() => {}} documents={documents} />
    </I18nProvider>,
  );
}

describe("<DocumentShareSheet> — one link for the selection", () => {
  it("seeds a single-doc share with the document title as the label", () => {
    const html = render([{ id: "d1", title: "Blood panel" }]);
    expect(html).toContain("Share this document");
    expect(html).toContain('data-document-only="true"');
    expect(html).toContain('data-doc-ids="d1"');
    expect(html).toContain('data-initial-label="Blood panel"');
  });

  it("folds N selected docs into ONE documents-only link with a count label", () => {
    const html = render([
      { id: "d1", title: "A" },
      { id: "d2", title: "B" },
      { id: "d3", title: "C" },
    ]);
    // Multi title, a "{count} documents" summary label, all ids in one link.
    expect(html).toContain("Share these documents");
    expect(html).toContain('data-doc-ids="d1,d2,d3"');
    expect(html).toContain('data-doc-count="3"');
    expect(html).toContain('data-initial-label="3 documents"');
    // Privacy: documents-only stays frozen on for the launched share.
    expect(html).toContain('data-document-only="true"');
  });

  it("does not mount the form when closed", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <DocumentShareSheet
          open={false}
          onOpenChange={() => {}}
          documents={[{ id: "d1", title: "A" }]}
        />
      </I18nProvider>,
    );
    expect(html).not.toContain('data-slot="mock-share-form"');
  });
});
