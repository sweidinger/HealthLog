/**
 * Query keys — illness / condition journal (v1.18.1): the episode list,
 * a single episode, and a single episode-day day-log.
 * Part of the centralized factory; aggregated in `./index.ts`.
 */
export const illnessKeys = {
  /**
   * v1.18.1 — illness-journal surfaces. `illness()` is the root prefix
   * every illness write invalidates through (`illnessDependentKeys` in
   * `./index.ts`). The episode list, a single episode read, and a per-day
   * day-log each get their own slot; any episode / day-log write evicts
   * the whole `["illness"]` prefix so the history list and the open sheet
   * repaint in lockstep.
   */
  illness: () => ["illness"] as const,
  illnessEpisodes: (includeResolved: boolean) =>
    ["illness", "episodes", includeResolved] as const,
  illnessEpisode: (id: string) => ["illness", "episode", id] as const,
  illnessDayLog: (episodeId: string, date: string) =>
    ["illness", "day-log", episodeId, date] as const,
  /**
   * v1.18.1 P3 — the per-episode retrospective correlation findings
   * (pre-onset scan, nadir, recovery-gap). Server-authoritative; the read
   * is gated, so the surface pattern-matches `status` rather than recomputing.
   */
  illnessCorrelation: (id: string) =>
    ["illness", "correlation", id] as const,
  /**
   * v1.18.1 P3 — the cross-episode retrospective summary ("sick N times ·
   * typical recovery gap X days") over a trailing window in days.
   */
  illnessInsights: (windowDays: number) =>
    ["illness", "insights", windowDays] as const,
};
