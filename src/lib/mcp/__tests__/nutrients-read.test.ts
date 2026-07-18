import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/modules/gate", () => ({ isModuleEnabled: vi.fn() }));
const { nutrientIntakeDay, user } = vi.hoisted(() => ({
  nutrientIntakeDay: { findMany: vi.fn() },
  user: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: { nutrientIntakeDay, user } }));

import { getNutrients, resolveNutrientCode } from "../nutrients-read";
import type {
  NutrientsOverviewResult,
  NutrientsDailyResult,
} from "../nutrients-read";
import { isModuleEnabled } from "@/lib/modules/gate";

/** Narrow the union to the overview shape for a test's own assertions. */
function overview(
  r: NutrientsOverviewResult | NutrientsDailyResult,
): NutrientsOverviewResult {
  return r as NutrientsOverviewResult;
}

/** Narrow the union to the per-nutrient shape for a test's own assertions. */
function daily(
  r: NutrientsOverviewResult | NutrientsDailyResult,
): NutrientsDailyResult {
  return r as NutrientsDailyResult;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isModuleEnabled).mockResolvedValue(true);
  vi.mocked(user.findUnique).mockResolvedValue({
    timezone: "UTC",
    gender: null,
  } as never);
  vi.mocked(nutrientIntakeDay.findMany).mockResolvedValue([] as never);
});

describe("resolveNutrientCode", () => {
  it("resolves the exact catalog code", () => {
    expect(resolveNutrientCode("water")).toBe("water");
    expect(resolveNutrientCode("vitamin_d")).toBe("vitamin_d");
  });

  it("folds spaces/hyphens and case", () => {
    expect(resolveNutrientCode("Vitamin D")).toBe("vitamin_d");
    expect(resolveNutrientCode("vitamin-d")).toBe("vitamin_d");
    expect(resolveNutrientCode("MAGNESIUM")).toBe("magnesium");
  });

  it("matches a display label (e.g. 'Vitamin B12')", () => {
    expect(resolveNutrientCode("Vitamin B12")).toBe("vitamin_b12");
  });

  it("returns null for an unknown name (never invents a code)", () => {
    expect(resolveNutrientCode("bananas")).toBeNull();
    expect(resolveNutrientCode("")).toBeNull();
  });
});

describe("getNutrients — module gate", () => {
  it("returns { present: false, reason: module_disabled } when the opt-in module is off", async () => {
    vi.mocked(isModuleEnabled).mockResolvedValue(false);
    const result = await getNutrients("user-1", {});
    expect(result).toEqual({ present: false, reason: "module_disabled" });
    expect(nutrientIntakeDay.findMany).not.toHaveBeenCalled();
  });
});

describe("getNutrients — overview mode (no `nutrient` arg)", () => {
  it("sums a day across sources and reports latest day / total / days-with-data", async () => {
    vi.mocked(nutrientIntakeDay.findMany).mockResolvedValue([
      // Two sources on the SAME latest day — must sum, not double-count the day.
      { nutrient: "water", unit: "ml", day: "2026-07-10", amount: 1200 },
      { nutrient: "water", unit: "ml", day: "2026-07-10", amount: 500 },
      { nutrient: "water", unit: "ml", day: "2026-07-09", amount: 2000 },
    ] as never);

    const result = overview(await getNutrients("user-1", {}));
    expect(result.present).toBe(true);
    expect(result.nutrients).toEqual([
      {
        nutrient: "water",
        label: "Water",
        unit: "ml",
        latestDay: "2026-07-10",
        latestAmount: 1700,
        daysWithData: 2,
      },
    ]);
  });

  it("returns { present: false, reason: no_data } when nothing is logged", async () => {
    const result = await getNutrients("user-1", {});
    expect(result).toMatchObject({ present: false, reason: "no_data" });
  });

  it("clamps an out-of-range `days` to the overview ceiling (365)", async () => {
    const result = overview(await getNutrients("user-1", { days: 10000 }));
    expect(result.windowDays).toBe(365);
  });
});

describe("getNutrients — per-nutrient mode", () => {
  it("returns a dense day series + the resolved reference for a known-sex profile", async () => {
    vi.mocked(user.findUnique).mockResolvedValue({
      timezone: "UTC",
      gender: "FEMALE",
    } as never);
    vi.mocked(nutrientIntakeDay.findMany).mockResolvedValue([
      { day: "2026-07-10", amount: 300 },
    ] as never);

    const result = daily(
      await getNutrients("user-1", { nutrient: "magnesium", days: 3 }),
    );
    expect(result.present).toBe(true);
    expect(result.nutrient).toBe("magnesium");
    expect(result.unit).toBe("mg");
    expect(result.days).toHaveLength(3);
    // Female reference for magnesium is 300 mg (EFSA DRV 2015).
    expect(result.reference).toEqual({
      kind: "AI",
      direction: "target",
      value: 300,
      source: "EFSA DRV 2015 (adults)",
    });
  });

  it("omits the reference (never guesses) when the profile has no sex on file", async () => {
    vi.mocked(user.findUnique).mockResolvedValue({
      timezone: "UTC",
      gender: null,
    } as never);
    const result = daily(
      await getNutrients("user-1", { nutrient: "magnesium" }),
    );
    expect(result.reference).toBeNull();
  });

  it("resolves a free-text nutrient name (display label)", async () => {
    const result = daily(
      await getNutrients("user-1", { nutrient: "Vitamin D" }),
    );
    expect(result.nutrient).toBe("vitamin_d");
  });

  it("returns { present: false, reason: unknown_nutrient } for an unresolvable name", async () => {
    const result = await getNutrients("user-1", { nutrient: "bananas" });
    expect(result).toEqual({ present: false, reason: "unknown_nutrient" });
    expect(nutrientIntakeDay.findMany).not.toHaveBeenCalled();
  });

  it("clamps an out-of-range `days` to the per-nutrient ceiling (90)", async () => {
    const result = daily(
      await getNutrients("user-1", { nutrient: "water", days: 9000 }),
    );
    expect(result.windowDays).toBe(90);
    expect(result.days).toHaveLength(90);
  });

  it("resolves caffeine's reference as an upper-guidance ceiling, not a target", async () => {
    const result = daily(
      await getNutrients("user-1", { nutrient: "caffeine" }),
    );
    expect(result.reference).toMatchObject({
      kind: "safeLevel",
      direction: "upperGuidance",
      value: 400,
    });
  });
});
