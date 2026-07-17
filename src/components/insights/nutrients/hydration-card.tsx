"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GlassWater, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TileHeader } from "@/components/insights/tile-header";
import { NutrientDailyBarChartDynamic } from "@/components/charts/nutrient-daily-bar-chart-dynamic";
import { WaterQuickAddSheet } from "@/components/insights/nutrients/water-quick-add-sheet";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import type { NutrientDailySeries } from "./types";

const WINDOW_DAYS = 30;

/**
 * v1.29 — hydration hero card on `/insights/nutrients`.
 *
 * Today's total (all sources summed) as the content value, a muted EFSA
 * reference-intake meta line (omitted when the profile has no sex on
 * file — the catalog's own contract), a 30-day bar chart with a dashed
 * reference line, and the quick-add entry point. No ring, no attainment
 * colour — the bar chart with a reference line IS the context
 * (UI-STANDARDS: value stays foreground, never coloured by attainment).
 */
export function HydrationCard() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const [sheetOpen, setSheetOpen] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.nutrientDaily("water", WINDOW_DAYS),
    queryFn: () =>
      apiGet<NutrientDailySeries>(
        `/api/nutrients/daily?nutrient=water&days=${WINDOW_DAYS}`,
      ),
  });

  if (isError) {
    return <QueryErrorCard onRetry={refetch} />;
  }

  const todayTotal = data?.days.at(-1)?.amount ?? 0;

  return (
    <Card data-slot="nutrients-hydration-card">
      <CardHeader>
        <TileHeader
          icon={GlassWater}
          title={t("nutrients.names.water")}
          right={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setSheetOpen(true)}
              data-slot="nutrients-hydration-add"
            >
              <Plus className="size-4" aria-hidden="true" />
              {t("nutrients.hydration.quickAddTitle")}
            </Button>
          }
        />
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading || !data ? (
          <div className="space-y-3" aria-hidden="true">
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-[240px] w-full" />
          </div>
        ) : (
          <>
            <div className="space-y-1">
              <p
                className="text-2xl font-bold tabular-nums"
                data-slot="nutrients-hydration-today"
              >
                {fmt.integer(Math.round(todayTotal))} {data.unit}
              </p>
              {data.reference ? (
                <p className="text-muted-foreground text-xs">
                  {t("nutrients.hydration.referenceMeta", {
                    value: fmt.integer(Math.round(data.reference.value)),
                    unit: data.unit,
                  })}
                </p>
              ) : null}
            </div>
            <NutrientDailyBarChartDynamic
              days={data.days}
              unit={data.unit}
              valueLabel={t("nutrients.names.water")}
              referenceValue={data.reference?.value ?? null}
            />
          </>
        )}
      </CardContent>
      <WaterQuickAddSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        todayTotalMl={Math.round(todayTotal)}
      />
    </Card>
  );
}
