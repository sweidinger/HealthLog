/**
 * Query keys — measurements, sleep night, and per-chart aggregate reads.
 * Part of the centralized factory; aggregated in `./index.ts`.
 */
export const measurementKeys = {
  measurements: () => ["measurements"] as const,

  /**
   * v1.15.13 — the measurements management-list read with its full filter
   * + sort + pagination state baked into the key so the cache slot is
   * correct for every filter combination (a `sourceEq` / date-range /
   * type / page / sort change re-keys instead of poisoning a shared
   * slot). Rides under the `["measurements"]` prefix so
   * `measurementDependentKeys` (and a bulk-delete invalidation) reaches
   * every slot at once. `mode` distinguishes the synthetic day-grouped /
   * sleep-night branches from the plain `raw` list.
   */
  measurementsList: (params: {
    type: string | undefined;
    sourceEq: string | undefined;
    from: string | undefined;
    to: string | undefined;
    page: number;
    sortBy: string;
    sortDir: string;
    mode: "raw" | "groupBy=day" | "sleep-night";
  }) =>
    [
      "measurements",
      "list",
      params.type ?? null,
      params.sourceEq ?? null,
      params.from ?? null,
      params.to ?? null,
      params.page,
      params.sortBy,
      params.sortDir,
      params.mode,
    ] as const,

  /**
   * v1.11.5 — last-night hypnogram (`GET /api/sleep/night`). The `date`
   * discriminator lets the night-picker step back through recent nights
   * without colliding caches; `undefined` is the most-recent night.
   */
  sleepNight: (date?: string) => ["sleep-night", date ?? "latest"] as const,

  /**
   * v1.17.0 — sleep-rhythm read (`GET /api/sleep/rhythm`): the
   * server-authoritative sleep-debt + chronotype DTO. Reads the same raw
   * SLEEP_DURATION rows the night view does, so a sleep write invalidates
   * it through the shared measurement-dependent set.
   */
  sleepRhythm: () => ["sleep-rhythm"] as const,

  /**
   * v1.4.40 W-RSC — per-chart daily-aggregate fetch from the dashboard
   * + insights chart row. Pre-fix the key was bare `["chart-data", …]`
   * across the codebase, which excluded it from
   * `measurementDependentKeys` and left chart caches stale for up to
   * 60 s after a measurement save (audit-C2). Routing through the
   * factory pulls every variant under a single
   * `["chart-data"]` invalidation prefix so a mutation refreshes the
   * tile strip + the chart row in lockstep.
   *
   * The shape carries the heavy parameter list because the chart query
   * is bounded by metric set, value mode, BMI divisor, timezone, and
   * fetch window; the factory packs those into a single tuple to keep
   * the cache layout byte-identical with the pre-v1.4.40 layout.
   */
  chartData: (
    types: string,
    valueMode: string,
    bmiDivisor: string | number,
    timezone: string,
    fromIso: string,
    toIso: string,
    // v1.7.0 — display-time value scale (e.g. m/s → km/h via 3.6).
    // Defaults to 1 so every pre-v1.7.0 caller packs a byte-identical
    // tuple; a non-default scale re-keys the cache so the processed
    // (scaled) series doesn't bleed across charts that share the
    // underlying raw window.
    valueScale: number = 1,
  ) =>
    [
      "chart-data",
      types,
      valueMode,
      bmiDivisor,
      timezone,
      fromIso,
      toIso,
      valueScale,
    ] as const,

  /**
   * v1.8.5 — bounded recent-timestamp read powering the
   * measurement-diversity nudge on an insights category page. Keyed by
   * the page's `MeasurementType` so each metric caches its own window.
   * Shares the `measurement-dependent` invalidation prefix below so an
   * edit/delete in the values subpage re-runs the clustering check.
   */
  measurementDiversity: (type: string) =>
    ["measurement-diversity", type] as const,
};
