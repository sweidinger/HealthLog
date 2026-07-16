import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The page surface reads `useRouter` (Conversations routes via the app router).
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { CoachConversation } from "../coach-conversation";

/**
 * v1.28.51 (Documents R3, Design A) — the doc-scope banner.
 *
 * When the Coach is scoped to a document (the `/coach?doc=<id>` hand-off from
 * the vault, before any thread exists), the shared `<CoachConversation>` surface
 * paints a "Document" badge + "Chatting about: <title>" and, when the document
 * is not yet content-indexed, the calm "read it with AI first" hint. On a normal
 * health thread the banner is absent. Replaces the deleted drawer's not-indexed /
 * scope coverage at the component level; the fenced-send guarantee is pinned by
 * `coach-send-target.test.ts`.
 *
 * `pendingDocumentId` seeds from the `initialDocumentId` prop via a `useState`
 * initializer, so the banner resolves in a single static-markup pass. The
 * document detail (`/api/documents/inbound/<id>`) is seeded into the cache so the
 * title + indexed status render without a network call.
 */

const DOC_ID = "e2edocscopedoc0000000001";
const TITLE = "Chest X-ray report";

const NOT_INDEXED_HINT =
  "Read this document with AI first in the vault so the Coach can answer about it.";

function makeClient(hasContentIndex: boolean): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // A fresh doc scope has no thread yet — keep the rail empty so the surface
  // stays on the new-chat hero and the banner is the thing under test.
  client.setQueryData(queryKeys.coachConversations(), {
    conversations: [],
    nextCursor: null,
  });
  client.setQueryData(queryKeys.coachAboutMeQuestions(), { questions: [] });
  client.setQueryData(queryKeys.inboundDocument(DOC_ID), {
    id: DOC_ID,
    title: TITLE,
    filename: "xray.pdf",
    hasContentIndex,
  });
  return client;
}

function render(node: React.ReactNode, client: QueryClient): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nProvider>,
  );
}

describe("<CoachConversation> doc-scope banner (R3)", () => {
  it("shows the badge + 'Chatting about' title for an indexed document scope", () => {
    const html = render(
      <CoachConversation surface="page" initialDocumentId={DOC_ID} />,
      makeClient(true),
    );
    expect(html).toContain('data-slot="coach-doc-scope"');
    expect(html).toContain("Document");
    expect(html).toContain(`Chatting about: ${TITLE}`);
    // Indexed → no "read it first" hint.
    expect(html).not.toContain(NOT_INDEXED_HINT);
  });

  it("shows the calm not-indexed hint when the document has no content index", () => {
    const html = render(
      <CoachConversation surface="page" initialDocumentId={DOC_ID} />,
      makeClient(false),
    );
    expect(html).toContain('data-slot="coach-doc-scope"');
    expect(html).toContain(NOT_INDEXED_HINT);
  });

  it("paints no banner on a normal health thread (no document scope)", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(queryKeys.coachConversations(), {
      conversations: [],
      nextCursor: null,
    });
    client.setQueryData(queryKeys.coachAboutMeQuestions(), { questions: [] });
    const html = render(<CoachConversation surface="page" />, client);
    expect(html).not.toContain('data-slot="coach-doc-scope"');
  });
});
