"use client";

import { Activity } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.9.0 — mood-stability tile.
 *
 * Surfaces the day-to-day stability score (0..100, higher = steadier)
 * computed server-side from the population standard deviation of the
 * daily means, plus a descriptive, non-judgemental band. Some variation
 * is healthy, so the band reads "steady" / "variable", never
 * "good" / "bad". Renders nothing when the score is unavailable (a sparse
 * logger below the minimum-days floor) so the page degrades gracefully.
 */

export type MoodStabilityBand =
  "verySteady" | "steady" | "variable" | "veryVariable";

export interface MoodStabilityData {
  score: number;
  band: MoodStabilityBand;
  days: number;
}

const BAND_KEY: Record<MoodStabilityBand, string> = {
  verySteady: "insights.mood.stability.bandVerySteady",
  steady: "insights.mood.stability.bandSteady",
  variable: "insights.mood.stability.bandVariable",
  veryVariable: "insights.mood.stability.bandVeryVariable",
};

export function MoodStabilityTile({
  stability,
}: {
  stability: MoodStabilityData | null;
}) {
  const { t } = useTranslations();

  if (stability == null) return null;

  return (
    <Card>
      <CardHeader>
        <TileHeader
          icon={Activity}
          title={t("insights.mood.stability.title")}
        />
      </CardHeader>
      <CardContent>
        <p className="text-foreground text-2xl font-semibold tabular-nums">
          {t("insights.mood.stability.value", {
            score: String(stability.score),
          })}
        </p>
        <p className="text-muted-foreground text-sm">
          {t(BAND_KEY[stability.band])}
        </p>
      </CardContent>
    </Card>
  );
}
