/**
 * v1.17.1 — TanStack Query keys for the structured lab-result store.
 *
 * `labResultsList` bakes the filter + pagination shape into the key so a
 * filter change refetches without a same-key cache collision (the project's
 * queryKey-factory invariant).
 */
export const labKeys = {
  labResults: () => ["lab-results"] as const,

  labResultsList: (params: {
    analyte: string | undefined;
    panel: string | undefined;
    from: string | undefined;
    to: string | undefined;
    page: number;
    sortDir: string;
  }) =>
    [
      "lab-results",
      "list",
      params.analyte ?? null,
      params.panel ?? null,
      params.from ?? null,
      params.to ?? null,
      params.page,
      params.sortDir,
    ] as const,
};
