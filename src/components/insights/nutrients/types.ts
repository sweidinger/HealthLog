/**
 * v1.29 — shared client-side DTOs for the `/insights/nutrients` cards.
 * Mirror the Zod response schemas in `src/lib/validations/nutrients.ts`
 * (`nutrientDailySeriesSchema` / `nutrientOverviewSchema`) — kept as
 * plain interfaces here so the client components stay decoupled from
 * the server-only Zod module graph.
 */

export interface ResolvedNutrientReferenceDto {
  kind: "PRI" | "AI" | "safeLevel";
  direction: "target" | "upperGuidance";
  value: number;
  source: string;
}

export interface NutrientDailySeries {
  nutrient: string;
  unit: string;
  windowDays: number;
  days: Array<{ day: string; amount: number }>;
  reference: ResolvedNutrientReferenceDto | null;
}

export interface NutrientOverviewRow {
  nutrient: string;
  unit: string;
  latestDay: string;
  latestAmount: number;
  daysWithData: number;
}

export interface NutrientIntakeOverview {
  windowDays: number;
  nutrients: NutrientOverviewRow[];
}
