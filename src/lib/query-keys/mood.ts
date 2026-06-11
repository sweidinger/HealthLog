/**
 * Query keys — mood entries, mood analytics, and the tag catalog.
 * Part of the centralized factory; aggregated in `./index.ts`.
 */
export const moodKeys = {
  moodEntries: () => ["mood-entries"] as const,

  /**
   * v1.15.13 — the mood management-list read with its filter + sort +
   * pagination state baked into the key, mirroring `measurementsList`.
   * Rides under the `["mood-entries"]` prefix so `moodDependentKeys`
   * (and a bulk-delete invalidation) reaches every slot.
   */
  moodEntriesList: (params: {
    mood: string | undefined;
    source: string | undefined;
    from: string | undefined;
    to: string | undefined;
    page: number;
    sortBy: string;
    sortDir: string;
  }) =>
    [
      "mood-entries",
      "list",
      params.mood ?? null,
      params.source ?? null,
      params.from ?? null,
      params.to ?? null,
      params.page,
      params.sortBy,
      params.sortDir,
    ] as const,

  moodAnalytics: () => ["mood-analytics"] as const,
  /**
   * v1.8.5 — pre-computed mood-insights aggregates (heatmap, distribution,
   * weekday, tag breakdown, cross-metric correlations) for the Mood
   * Insights page. Read-only; invalidated on a mood write through the
   * `moodDependentKeys` fan-out in `./index.ts`.
   */
  moodInsights: () => ["mood-insights"] as const,
  /**
   * v1.8.5 — structured mood-tag taxonomy catalog (global reference
   * data, identical for every user). Read by the mood-logging form's
   * tag-category capture surface. Not invalidated on a mood write — the
   * catalog only changes on a migration / admin edit, so a long
   * `staleTime` is fine.
   */
  moodTagCatalog: () => ["mood-tag-catalog"] as const,
};
