"use client";

import dynamic from "next/dynamic";
import type { ComponentProps, ReactElement } from "react";

import { ChartErrorBoundary } from "@/components/charts/chart-error-state";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { importWithRetry } from "@/lib/retry-import";

/**
 * v1.29 — single `next/dynamic` boundary for `<NutrientDailyBarChart>`,
 * mirroring `health-chart-dynamic.tsx`. Both the hydration card and the
 * caffeine card on `/insights/nutrients` share this one lazy boundary so
 * recharts stays off the route's first-load JS and is fetched once.
 */
const NutrientDailyBarChartLazy = dynamic(
  () =>
    importWithRetry(() => import("@/components/charts/chart-runtime")).then(
      (mod) => ({ default: mod.NutrientDailyBarChart }),
    ),
  { ssr: false, loading: () => <ChartSkeleton /> },
);

export function NutrientDailyBarChartDynamic(
  props: ComponentProps<typeof NutrientDailyBarChartLazy>,
): ReactElement {
  return (
    <ChartErrorBoundary>
      <NutrientDailyBarChartLazy {...props} />
    </ChartErrorBoundary>
  );
}
