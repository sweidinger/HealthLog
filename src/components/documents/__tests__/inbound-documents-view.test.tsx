import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type {
  ExtractedFactDto,
  InboundDocumentDetailDto,
  InboundDocumentDto,
} from "@/lib/validations/inbound-documents";

/**
 * v1.25 — the Documents library.
 *
 * The harness is SSR-only (node env, no jsdom): we seed the TanStack cache and
 * assert the static markup. Interaction-driven paths (the exact request params,
 * the provider-unsupported classification) are covered by the pure-helper unit
 * tests in `library-utils.test.ts`; here we assert the rendered library, the
 * detail/review surface, the edit form, and the inline provider note.
 */

vi.mock("@/lib/api/api-fetch", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/api-fetch")>(
    "@/lib/api/api-fetch",
  );
  return {
    ...actual,
    apiFetch: () => new Promise(() => {}),
    apiPost: vi.fn(),
    apiPatch: vi.fn(),
    apiDelete: vi.fn(),
  };
});

import {
  AlreadyConfirmedNote,
  DocumentDetail,
  DocumentMetaEditForm,
  InboundDocumentsView,
  ProviderUnsupportedNote,
} from "../inbound-documents-view";

function doc(
  id: string,
  over: Partial<InboundDocumentDto> = {},
): InboundDocumentDto {
  return {
    id,
    kind: "LAB_RESULT",
    title: null,
    filename: `${id}.pdf`,
    mimeType: "application/pdf",
    byteSize: 1000,
    status: "STORED",
    providerType: null,
    reportDate: null,
    documentDate: "2026-06-20",
    errorReason: null,
    factCount: 0,
    pendingCount: 0,
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
    ...over,
  };
}

function render(node: React.ReactNode, seed?: (qc: QueryClient) => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  seed?.(queryClient);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<InboundDocumentsView> library", () => {
  it("renders the grouped list with titles, badges, and load-more", () => {
    const html = render(<InboundDocumentsView />, (qc) => {
      qc.setQueryData(
        queryKeys.inboundDocumentList({
          q: undefined,
          kind: undefined,
          sort: "documentDate",
          order: "desc",
        }),
        {
          pages: [
            {
              documents: [
                doc("d1", {
                  title: "Cardiology report",
                  documentDate: "2026-06-20",
                  pendingCount: 2,
                  factCount: 3,
                }),
                doc("d2", {
                  title: "Blood panel",
                  documentDate: "2026-06-20",
                }),
              ],
              nextCursor: "cursor-next",
            },
          ],
          pageParams: [null],
        },
      );
    });

    // Library + toolbar shells render.
    expect(html).toContain('data-slot="documents-library"');
    expect(html).toContain('data-slot="documents-toolbar"');
    // Date group header + rows.
    expect(html).toContain('data-slot="documents-date-group"');
    expect(html).toContain('data-slot="documents-row"');
    // Titles surface (title preferred over filename).
    expect(html).toContain("Cardiology report");
    expect(html).toContain("Blood panel");
    // Kind + status badges from the EN bundle.
    expect(html).toContain("Lab result");
    expect(html).toContain("Stored");
    // pendingCount badge.
    expect(html).toContain("2 to review");
    // nextCursor → load-more button.
    expect(html).toContain("Load more");
    // A11Y-M2: the row's aria-controls points at the detail region id.
    expect(html).toContain('aria-controls="documents-detail-d1"');
    // QoL: accepted formats + size ceiling are shown by the file field.
    expect(html).toContain("JPEG, PNG, WebP or PDF · up to 12 MB");
  });

  it("disables the upload button and shows a hint until a file is chosen", () => {
    const html = render(<InboundDocumentsView />, (qc) => {
      qc.setQueryData(
        queryKeys.inboundDocumentList({
          q: undefined,
          kind: undefined,
          sort: "documentDate",
          order: "desc",
        }),
        { pages: [{ documents: [], nextCursor: null }], pageParams: [null] },
      );
    });
    // A11Y-M4: with no file staged, an inline hint explains why upload is
    // disabled (the hint only renders on the !hasFile / not-pending path).
    expect(html).toContain("Choose a file to upload.");
  });

  it("renders the document-date range filter inputs", () => {
    const html = render(<InboundDocumentsView />, (qc) => {
      qc.setQueryData(
        queryKeys.inboundDocumentList({
          q: undefined,
          kind: undefined,
          sort: "documentDate",
          order: "desc",
        }),
        { pages: [{ documents: [], nextCursor: null }], pageParams: [null] },
      );
    });
    // PERF-L: from/to date inputs are wired into the toolbar.
    expect(html).toContain('id="doc-from"');
    expect(html).toContain('id="doc-to"');
  });

  it("shows the empty state when there are no documents", () => {
    const html = render(<InboundDocumentsView />, (qc) => {
      qc.setQueryData(
        queryKeys.inboundDocumentList({
          q: undefined,
          kind: undefined,
          sort: "documentDate",
          order: "desc",
        }),
        { pages: [{ documents: [], nextCursor: null }], pageParams: [null] },
      );
    });
    expect(html).toContain("No documents yet.");
    expect(html).not.toContain('data-slot="documents-row"');
  });
});

function fact(id: string): ExtractedFactDto {
  return {
    id,
    factType: "OBSERVATION",
    status: "PENDING",
    confidence: 0.9,
    needsReview: false,
    data: {
      label: "LDL Cholesterol",
      code: null,
      codeSystem: null,
      value: 95,
      valueText: null,
      unit: "mg/dL",
      referenceLow: null,
      referenceHigh: null,
      effectiveDate: "2026-06-20",
    },
    provenance: { sourceText: "LDL 95 mg/dL", page: 0, confidence: 0.9 },
    committedRecordId: null,
    committedRecordType: null,
  };
}

describe("<DocumentDetail>", () => {
  function detail(over: Partial<InboundDocumentDetailDto> = {}) {
    return {
      ...doc("d1", { title: "Cardiology report", status: "EXTRACTED" }),
      facts: [fact("f1")],
      ...over,
    } as InboundDocumentDetailDto;
  }

  it("renders the original link, edit + extract controls, and the review facts", () => {
    const html = render(
      <DocumentDetail documentId="d1" onClosed={() => {}} />,
      (qc) => {
        qc.setQueryData(queryKeys.inboundDocument("d1"), detail());
      },
    );
    expect(html).toContain('data-slot="documents-detail"');
    // Original view link points at the raw-bytes route.
    expect(html).toContain("/api/documents/inbound/d1/original");
    expect(html).toContain('data-slot="documents-edit-trigger"');
    // Extract button is present (status is not CONFIRMED).
    expect(html).toContain('data-slot="documents-extract"');
    expect(html).toContain("Extract facts");
    // The staged fact's transcription summary renders for review.
    expect(html).toContain("LDL Cholesterol");
    expect(html).toContain("Save approved facts");
  });

  it("hides the extract button once the document is confirmed", () => {
    const html = render(
      <DocumentDetail documentId="d1" onClosed={() => {}} />,
      (qc) => {
        qc.setQueryData(
          queryKeys.inboundDocument("d1"),
          detail({ status: "CONFIRMED", facts: [] }),
        );
      },
    );
    expect(html).not.toContain('data-slot="documents-extract"');
  });

  it("hides the extract button once any fact is approved (PERF-H1 gate)", () => {
    const approved: ExtractedFactDto = { ...fact("f1"), status: "APPROVED" };
    const html = render(
      <DocumentDetail documentId="d1" onClosed={() => {}} />,
      (qc) => {
        qc.setQueryData(
          queryKeys.inboundDocument("d1"),
          detail({ status: "EXTRACTED", factCount: 1, facts: [approved] }),
        );
      },
    );
    expect(html).not.toContain('data-slot="documents-extract"');
  });

  it("threads the region id onto the detail card for aria-controls", () => {
    const html = render(
      <DocumentDetail
        documentId="d1"
        regionId="documents-detail-d1"
        onClosed={() => {}}
      />,
      (qc) => {
        qc.setQueryData(queryKeys.inboundDocument("d1"), detail());
      },
    );
    expect(html).toContain('id="documents-detail-d1"');
  });

  it("falls back to the kind label when title and filename are absent", () => {
    const html = render(
      <DocumentDetail documentId="d1" onClosed={() => {}} />,
      (qc) => {
        qc.setQueryData(
          queryKeys.inboundDocument("d1"),
          detail({ title: null, filename: null, kind: "IMAGING" }),
        );
      },
    );
    expect(html).toContain("Imaging");
  });

  it("shows the committed facts summary once approved, not the empty note", () => {
    const approved: ExtractedFactDto = { ...fact("f1"), status: "APPROVED" };
    const html = render(
      <DocumentDetail documentId="d1" onClosed={() => {}} />,
      (qc) => {
        qc.setQueryData(
          queryKeys.inboundDocument("d1"),
          detail({ status: "CONFIRMED", factCount: 1, facts: [approved] }),
        );
      },
    );
    // M6: provenance stays visible — the approved facts are listed read-only…
    expect(html).toContain('data-slot="documents-committed"');
    expect(html).toContain("Approved from this document");
    expect(html).toContain("LDL Cholesterol");
    // …instead of stranding the user on "Nothing left to review."
    expect(html).not.toContain("Nothing left to review.");
  });

  it("explains why a low-confidence fact can't be approved yet", () => {
    const lowConf: ExtractedFactDto = { ...fact("f1"), needsReview: true };
    const html = render(
      <DocumentDetail documentId="d1" onClosed={() => {}} />,
      (qc) => {
        qc.setQueryData(
          queryKeys.inboundDocument("d1"),
          detail({ facts: [lowConf] }),
        );
      },
    );
    // M7: the disabled Approve is tied to a plain-language reason.
    expect(html).toContain("Edit this fact to approve it.");
    expect(html).toContain("Needs review");
  });

  it("offers a confirm step before discarding", () => {
    const html = render(
      <DocumentDetail documentId="d1" onClosed={() => {}} />,
      (qc) => {
        qc.setQueryData(queryKeys.inboundDocument("d1"), detail());
      },
    );
    // A11Y-M3: discard is gated behind an AlertDialog trigger, not one click.
    expect(html).toContain('data-slot="documents-discard-trigger"');
  });
});

describe("<DocumentMetaEditForm>", () => {
  it("renders the metadata fields seeded from the document", () => {
    const html = render(
      <DocumentMetaEditForm
        doc={doc("d1", { title: "Old title", documentDate: "2026-06-20" })}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('data-slot="documents-edit-form"');
    expect(html).toContain('value="Old title"');
    expect(html).toContain('value="2026-06-20"');
    expect(html).toContain("Save");
  });
});

describe("<ProviderUnsupportedNote>", () => {
  it("renders the calm inline note as a polite live region (A11Y-H1)", () => {
    const html = render(<ProviderUnsupportedNote />);
    expect(html).toContain('data-slot="documents-provider-note"');
    expect(html).toContain("Configure a document-scan provider");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });
});

describe("<AlreadyConfirmedNote>", () => {
  it("renders a calm polite live region when extraction is refused", () => {
    const html = render(<AlreadyConfirmedNote />);
    expect(html).toContain('data-slot="documents-already-confirmed-note"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("already been reviewed");
  });
});
