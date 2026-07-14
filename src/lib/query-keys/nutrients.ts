/**
 * Query keys — nutrient-intake sync (v1.28). One read: the window
 * summary behind the read-only Settings → Sources card. Part of the
 * centralized factory; aggregated in `./index.ts`.
 */
export const nutrientKeys = {
  /** Per-nutrient window summary from `GET /api/nutrients?days=N`. */
  nutrientIntake: (days: number) => ["nutrients", "intake", days] as const,
};
