/**
 * Query keys — clinical documents library (v1.25, W-DOCS-IN): the browsable
 * document list (search / category filter / sort, keyset-paginated) and a
 * single document's detail (document + staged facts). Part of the centralized
 * factory; aggregated in `./index.ts`. Any document write (upload / edit /
 * extract / confirm / discard) invalidates the `["documents"]` prefix so the
 * list and the open detail repaint in lockstep.
 */
import type {
  DocumentListSort,
  InboundDocumentKindValue,
} from "@/lib/validations/inbound-documents";

/**
 * The parameter set that distinguishes one library list view from another.
 * Lives in the key so two different filter/sort combinations never share a
 * cache bucket. `undefined` fields are dropped by TanStack's stable hash, so a
 * bare `{ sort, order }` and `{ q: undefined, kind: undefined, sort, order }`
 * resolve to the same key.
 */
export interface DocumentListParams {
  q?: string;
  kind?: InboundDocumentKindValue;
  from?: string;
  to?: string;
  sort: DocumentListSort;
  order: "asc" | "desc";
}

export const documentKeys = {
  documents: () => ["documents"] as const,
  inboundDocuments: () => ["documents", "inbound"] as const,
  /**
   * The parameterised library list (keyset-paginated via `useInfiniteQuery`).
   * The literal `"list"` segment keeps it distinct from a single-document key
   * (`inboundDocument(id)`); cuid ids never collide with it. Stays under the
   * `["documents", "inbound"]` prefix so prefix invalidation still reaches it.
   */
  inboundDocumentList: (params: DocumentListParams) =>
    ["documents", "inbound", "list", params] as const,
  inboundDocument: (id: string) => ["documents", "inbound", id] as const,
};
