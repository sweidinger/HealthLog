/**
 * Query keys — hydration tree: today's water-intake total vs the daily goal
 * (`/api/hydration`). Part of the centralized factory; aggregated in
 * `./index.ts`. A `WATER_INTAKE` measurement write busts this key through the
 * `measurementDependentKeys` bundle so the goal ring refreshes in lockstep.
 */
export const hydrationKeys = {
  hydration: () => ["hydration"] as const,
  hydrationToday: () => ["hydration", "today"] as const,
};
