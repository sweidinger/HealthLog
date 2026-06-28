/**
 * Query keys — allergies (v1.25, W-RECORDS). The allergy list + a single
 * allergy read. Part of the centralized factory; aggregated in `./index.ts`.
 */
export const allergyKeys = {
  /**
   * `allergies()` is the root prefix every allergy write invalidates through.
   * `allergyList(includeInactive)` keys the list (the inactive toggle is part
   * of the key so the two response sets cache distinctly). Any allergy write
   * evicts the whole `["allergies"]` prefix so the list + open sheet repaint
   * in lockstep.
   */
  allergies: () => ["allergies"] as const,
  allergyList: (includeInactive: boolean) =>
    ["allergies", "list", includeInactive] as const,
  allergy: (id: string) => ["allergies", "detail", id] as const,
};
