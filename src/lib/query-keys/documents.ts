/**
 * Query keys — the Dokumente vault: the filtered timeline list (keyset-
 * paginated), a single document's detail, and the usage/limits read the
 * upload path pre-flights against. Part of the centralized factory;
 * aggregated in `./index.ts`. Any document write (upload / edit / link /
 * delete / restore / bulk) invalidates the `["documents"]` prefix so the
 * timeline, an open detail sheet, and the quota bar repaint in lockstep.
 */
import type { InboundDocumentKindValue } from "@/lib/validations/inbound-documents";

/**
 * The parameter set that distinguishes one vault timeline view from another —
 * mirrors the URL facets (`?q&kind&episode&year`) one-to-one so a deep link
 * and an in-page filter change resolve to the same cache bucket. `undefined`
 * fields are dropped by TanStack's stable hash, so an all-defaults view and
 * an explicit `{ q: undefined, … }` share a key. Sort is pinned server-side
 * (filing date, newest first) and is deliberately NOT part of the key.
 */
export interface DocumentVaultFilters {
  q?: string;
  /** Type facet — OR inside the facet, sorted before keying by the caller. */
  kinds?: InboundDocumentKindValue[];
  /** Only documents linked to this illness/condition episode. */
  episodeId?: string;
  /** Only documents whose filing date falls in this calendar year. */
  year?: number;
}

export const documentKeys = {
  documents: () => ["documents"] as const,
  inboundDocuments: () => ["documents", "inbound"] as const,
  /**
   * The parameterised vault list (keyset-paginated via `useInfiniteQuery`).
   * The literal `"list"` segment keeps it distinct from a single-document key
   * (`inboundDocument(id)`); cuid ids never collide with it. Stays under the
   * `["documents", "inbound"]` prefix so prefix invalidation still reaches it.
   */
  inboundDocumentList: (filters: DocumentVaultFilters) =>
    ["documents", "inbound", "list", filters] as const,
  inboundDocument: (id: string) => ["documents", "inbound", id] as const,
  /**
   * Storage usage + effective limits (`GET /api/documents/inbound/usage`).
   * Invalidated through the `["documents"]` prefix after every upload /
   * delete so the quota bar tracks reality.
   */
  inboundDocumentUsage: () => ["documents", "inbound", "usage"] as const,
};
