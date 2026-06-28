/**
 * Query keys — family history (v1.25, W-RECORDS). The entry list + a single
 * entry read. Part of the centralized factory; aggregated in `./index.ts`.
 */
export const familyHistoryKeys = {
  /**
   * `familyHistory()` is the root prefix every family-history write
   * invalidates through. Any write evicts the whole `["family-history"]`
   * prefix so the list + open sheet repaint in lockstep.
   */
  familyHistory: () => ["family-history"] as const,
  familyHistoryList: () => ["family-history", "list"] as const,
  familyHistoryEntry: (id: string) => ["family-history", "detail", id] as const,
};
