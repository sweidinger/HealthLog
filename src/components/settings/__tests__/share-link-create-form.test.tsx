/**
 * The shared clinician share-link CREATE flow. It is mounted from two places
 * — Settings → Sharing and the document detail sheet's Share action — so the
 * test pins the two behaviours the document entry point relies on:
 *   1. Mounted bare (the Settings default) it renders the create form with the
 *      90-day-capped expiry, the attach affordance, the frozen-set warning,
 *      and no pre-attached document.
 *   2. Mounted with `initialDocuments` + `initialLabel` (the document flow) it
 *      pre-fills the label and seeds the attached-document chip, so sharing a
 *      document lands on a create form already scoped to it.
 *
 * SSR-static render only (no jsdom), matching the sibling settings tests. The
 * TanStack hooks are mocked; the QR (`qrcode`) only ever renders in an effect
 * after a create, so it never runs under `renderToStaticMarkup`.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tanstack/react-query", () => ({
  // The always-mounted ShareDocumentPicker reads via useQuery; the form
  // itself creates via useMutation.
  useQuery: () => ({ data: undefined, isPending: false, isError: false }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { ShareLinkCreateForm } from "../share-link-create-form";
import type { PickedDocument } from "../share-document-picker";

function render(
  props: {
    initialDocuments?: PickedDocument[];
    initialLabel?: string;
  } = {},
  locale: "en" | "de" = "en",
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <ShareLinkCreateForm {...props} />
    </I18nProvider>,
  );
}

describe("<ShareLinkCreateForm> — shared create flow", () => {
  it("renders the create form with the 90-day-capped expiry and attach affordance", () => {
    const html = render();
    expect(html).toContain('max="90"');
    expect(html).toContain("Create link");
    expect(html).toContain('data-testid="share-attach-open"');
    expect(html).toContain("Choose documents");
  });

  it("surfaces the frozen-set warning so the write-once contract is explicit", () => {
    const html = render();
    expect(html).toContain("fixed once you create the link");
  });

  it("does not reveal a token before a create succeeds", () => {
    const html = render();
    expect(html).not.toContain('data-testid="share-token-reveal"');
  });

  it("mounts bare with no pre-attached document (the Settings default)", () => {
    const html = render();
    expect(html).not.toContain('data-testid="share-attached-chips"');
    expect(html).toContain("0 of 50 selected");
  });

  it("seeds the label and the attached-document chip from the document flow", () => {
    const html = render({
      initialDocuments: [{ id: "doc-1", title: "Blood panel 2026" }],
      initialLabel: "Blood panel 2026",
    });
    // Label pre-filled with the document title.
    expect(html).toContain('value="Blood panel 2026"');
    // The document rides in as a removable chip, and the count reflects it.
    expect(html).toContain('data-testid="share-attached-chips"');
    expect(html).toContain("Blood panel 2026");
    expect(html).toContain("1 of 50 selected");
    // A seeded set surfaces the EXIF note the picker path also shows.
    expect(html).toContain("Camera metadata");
  });
});
