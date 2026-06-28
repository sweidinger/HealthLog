/**
 * Query keys — inbound clinical documents (v1.25, W-DOCS-IN): the document
 * list and a single document's review detail (document + staged facts).
 * Part of the centralized factory; aggregated in `./index.ts`. Any inbound
 * write (upload / edit / confirm / discard) invalidates the `["documents"]`
 * prefix so the list and the open review repaint in lockstep.
 */
export const documentKeys = {
  documents: () => ["documents"] as const,
  inboundDocuments: () => ["documents", "inbound"] as const,
  inboundDocument: (id: string) => ["documents", "inbound", id] as const,
};
