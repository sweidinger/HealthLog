"use client";

import { Activity, Gauge, Moon, Repeat, Target, Waves } from "lucide-react";

import { useInsightsAnalytics } from "@/hooks/use-insights-analytics";
import { useTranslations } from "@/lib/i18n/context";
import { SectionHeading } from "@/components/insights/section-heading";
import { DeviceScoreTile } from "@/components/insights/device-score-tile";

/**
 * v1.17.1 — "Sleep quality" block on `/insights/sleep`.
 *
 * Surfaces the WHOOP / Oura nightly sleep-quality scores that were ingested
 * end-to-end but rendered nowhere: efficiency, performance, consistency, need,
 * disturbance count, and the Oura headline sleep score. Each tile is gated on
 * the metric having data (`<DeviceScoreTile>` returns null at count 0), so a
 * non-wearable user never sees an empty card and the whole section collapses
 * when none of the six has readings.
 *
 * Reads the shared `["analytics", "summaries"]` slice — the same cache the
 * page's duration gate already populated, so this adds no network round-trip.
 * Server-authoritative: the tiles render the stored values, never a recompute.
 */
export function SleepQualitySection({ enabled }: { enabled: boolean }) {
  const { t } = useTranslations();
  const { data } = useInsightsAnalytics("SLEEP_DURATION");

  if (!enabled) return null;

  const summaries = data?.summaries;
  if (!summaries) return null;

  const tiles: Array<{
    type: string;
    title: string;
    icon: typeof Moon;
    color: string;
    unit?: string;
  }> = [
    {
      type: "SLEEP_SCORE",
      title: t("measurements.typeSleepScore"),
      icon: Moon,
      color: "#bd93f9",
      unit: t("insights.deviceScore.unitScore"),
    },
    {
      type: "SLEEP_PERFORMANCE",
      title: t("measurements.typeSleepPerformance"),
      icon: Target,
      color: "#8be9fd",
      unit: "%",
    },
    {
      type: "SLEEP_EFFICIENCY",
      title: t("measurements.typeSleepEfficiency"),
      icon: Gauge,
      color: "#50fa7b",
      unit: "%",
    },
    {
      type: "SLEEP_CONSISTENCY",
      title: t("measurements.typeSleepConsistency"),
      icon: Repeat,
      color: "#f1fa8c",
      unit: "%",
    },
    {
      type: "SLEEP_NEED",
      title: t("measurements.typeSleepNeed"),
      icon: Waves,
      color: "#ffb86c",
      unit: t("insights.deviceScore.unitMinutes"),
    },
    {
      type: "SLEEP_DISTURBANCE_COUNT",
      title: t("measurements.typeSleepDisturbanceCount"),
      icon: Activity,
      color: "#ff79c6",
    },
  ];

  const present = tiles.filter(
    (tile) => (summaries[tile.type]?.count ?? 0) > 0,
  );
  if (present.length === 0) return null;

  return (
    <section data-slot="sleep-quality-section" className="space-y-3">
      <SectionHeading
        icon={Moon}
        title={t("insights.sleepQuality.title")}
        action={
          <p className="text-muted-foreground text-xs">
            {t("insights.sleepQuality.subtitle")}
          </p>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {present.map((tile) => (
          <DeviceScoreTile
            key={tile.type}
            type={tile.type}
            summary={summaries[tile.type]}
            title={tile.title}
            icon={tile.icon}
            color={tile.color}
            unit={tile.unit}
          />
        ))}
      </div>
    </section>
  );
}
