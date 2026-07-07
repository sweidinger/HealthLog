import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The vault page's designed states, pinned via single-pass static renders:
 *
 *   - first load paints the skeleton grid (`documents-loading`) — a shape
 *     that matches the loaded card grid, never a bare spinner;
 *   - an empty unfiltered corpus paints the TEACHING empty state (what
 *     belongs here + an upload affordance), not the error copy;
 *   - an empty FILTERED view paints the no-matches state with a
 *     clear-filters affordance — a distinct state, per the standards a
 *     failed query may never fall through to either.
 */

let mockSearch = "";
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  usePathname: () => "/documents",
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", modules: { inboundDocuments: true } },
    isLoading: false,
    isAuthenticated: true,
  }),
}));

vi.mock("@/lib/api/api-fetch", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/api-fetch")>(
    "@/lib/api/api-fetch",
  );
  return {
    ...actual,
    // Never resolves within the synchronous SSR render → queries whose
    // cache is not seeded stay pending.
    apiGet: () => new Promise(() => {}),
    apiPatch: vi.fn(),
    apiPost: vi.fn(),
    apiDelete: vi.fn(),
  };
});

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { DocumentsView } from "../documents-view";

function render(search: string, seedList?: { kinds?: never } | object) {
  mockSearch = search;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (seedList !== undefined) {
    queryClient.setQueryData(queryKeys.inboundDocumentList(seedList), {
      pages: [{ documents: [], nextCursor: null }],
      pageParams: [null],
    });
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <DocumentsView />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<DocumentsView> states", () => {
  it("first load: skeleton grid matching the card layout, no spinner", () => {
    const html = render("");
    expect(html).toContain('data-slot="documents-loading"');
    expect(html).toContain('data-slot="skeleton"');
    expect(html).toContain('data-slot="document-filter-bar"');
    expect(html).toContain('data-slot="document-upload-zone"');
    // A pending list must never read as an empty vault.
    expect(html).not.toContain("Your document vault is empty");
  });

  it("filter bar: type facet is a compact dropdown, not an inline chip row", () => {
    const html = render("");
    // The type facet renders as a single dropdown trigger labelled by the
    // active selection ("All types" while nothing is picked)…
    expect(html).toContain('data-slot="document-type-filter"');
    expect(html).toContain("All types");
    // …and the controls share ONE row — the container never wraps.
    expect(html).toContain("flex-nowrap");
    // The old horizontal chip scroller is gone.
    expect(html).not.toContain("overflow-x-auto");
  });

  it("filter bar: an active type selection labels the dropdown trigger", () => {
    const html = render("kind=IMAGING", { kinds: ["IMAGING"] });
    // Selection flows into the URL (→ the list query) AND surfaces on the
    // trigger label rather than a pressed chip.
    expect(html).toContain('data-slot="document-type-filter"');
    expect(html).toContain(">Imaging<");
    expect(html).not.toContain("All types");
  });

  it("empty unfiltered corpus: the teaching empty state with an upload CTA", () => {
    const html = render("", {});
    expect(html).toContain('data-slot="empty-state"');
    expect(html).toContain("Your document vault is empty");
    expect(html).toContain("Upload a first document");
    expect(html).not.toContain("No matching documents");
  });

  it("empty filtered view: the distinct no-matches state with clear-filters", () => {
    const html = render("kind=IMAGING", { kinds: ["IMAGING"] });
    expect(html).toContain("No matching documents");
    expect(html).toContain("Clear filters");
    expect(html).not.toContain("Your document vault is empty");
  });
});
