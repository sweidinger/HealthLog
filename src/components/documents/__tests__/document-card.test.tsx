import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";
import { DocumentCard, UploadStateCard } from "../document-card";
import type { UploadQueueItem } from "../use-document-upload";

/**
 * The vault card's render contract: title falls back filename → "untitled",
 * the meta line stays muted, the attachment-class badge appears ONLY for
 * download-only formats, condition links paint as pills, and the two
 * transient upload cards (in-flight ring / translated failure) render from
 * the same footprint.
 */

function doc(overrides: Partial<InboundDocumentDto> = {}): InboundDocumentDto {
  return {
    id: "doc-1",
    kind: "IMAGING",
    title: "MRT Knie",
    filename: "mrt-knie.pdf",
    mimeType: "application/pdf",
    byteSize: 2_500_000,
    status: "STORED",
    providerType: null,
    reportDate: null,
    documentDate: "2025-10-04",
    errorReason: null,
    factCount: 0,
    pendingCount: 0,
    conditionLinks: [{ episodeId: "ep-knee", name: "Knie" }],
    servingClass: "inline",
    hasContentIndex: false,
    createdAt: "2025-10-05T08:00:00.000Z",
    updatedAt: "2025-10-05T08:00:00.000Z",
    ...overrides,
  };
}

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

const noop = () => {};

describe("<DocumentCard>", () => {
  it("renders title, condition pill, and NO attachment badge for inline docs", () => {
    const html = render(
      <DocumentCard
        document={doc()}
        selected={false}
        onToggleSelected={noop}
        onOpen={noop}
        highlighted={false}
      />,
    );
    expect(html).toContain("MRT Knie");
    expect(html).toContain("Knie");
    expect(html).toContain('data-document-id="doc-1"');
    expect(html).not.toContain("Download only");
  });

  it("shows the download-only badge for attachment-class documents", () => {
    const html = render(
      <DocumentCard
        document={doc({
          servingClass: "attachment",
          hasContentIndex: false,
          mimeType: "application/octet-stream",
          filename: "befund.docx",
          title: null,
        })}
        selected={false}
        onToggleSelected={noop}
        onOpen={noop}
        highlighted={false}
      />,
    );
    expect(html).toContain("Download only");
    // Title falls back to the filename.
    expect(html).toContain("befund.docx");
  });

  it("marks a content-indexed document as searchable", () => {
    const html = render(
      <DocumentCard
        document={doc({ hasContentIndex: true })}
        selected={false}
        onToggleSelected={noop}
        onOpen={noop}
        highlighted={false}
      />,
    );
    expect(html).toContain('data-slot="document-searchable"');
    expect(html).toContain("Contents searchable");
  });

  it("shows no searchable marker when the document is not indexed", () => {
    const html = render(
      <DocumentCard
        document={doc({ hasContentIndex: false, conditionLinks: [] })}
        selected={false}
        onToggleSelected={noop}
        onOpen={noop}
        highlighted={false}
      />,
    );
    expect(html).not.toContain('data-slot="document-searchable"');
  });

  it("falls back to the untitled label and rings when highlighted", () => {
    const html = render(
      <DocumentCard
        document={doc({ title: null, filename: null })}
        selected={false}
        onToggleSelected={noop}
        onOpen={noop}
        highlighted
      />,
    );
    expect(html).toContain("Untitled document");
    expect(html).toContain("ring-2");
  });
});

describe("<UploadStateCard>", () => {
  const base: UploadQueueItem = {
    localId: "u1",
    fileName: "scan.jpg",
    byteSize: 4_000_000,
    status: "uploading",
    progress: 0.4,
  };

  it("paints the progress ring while uploading", () => {
    const html = render(<UploadStateCard item={base} onDismiss={noop} />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="40"');
    expect(html).toContain("scan.jpg");
  });

  it("renders the translated over-limit reason with the configured cap", () => {
    const html = render(
      <UploadStateCard
        item={{
          ...base,
          status: "error",
          failure: {
            ok: false,
            reason: "fileTooLarge",
            maxFileBytes: 26_214_400,
          },
        }}
        onDismiss={noop}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("25 MB");
    expect(html).not.toContain('role="progressbar"');
  });

  it("renders the quota reason with used/quota figures", () => {
    const html = render(
      <UploadStateCard
        item={{
          ...base,
          status: "error",
          failure: {
            ok: false,
            reason: "quotaExceeded",
            quotaBytes: 1_073_741_824,
            usedBytes: 1_020_054_732,
          },
        }}
        onDismiss={noop}
      />,
    );
    expect(html).toContain("Storage is full");
    expect(html).toContain("1 GB");
  });
});
