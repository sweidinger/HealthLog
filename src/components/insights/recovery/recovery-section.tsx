"use client";

import Link from "next/link";
import {
  Activity,
  Battery,
  Flame,
  Gauge,
  Heart,
  HeartPulse,
  TrendingUp,
} from "lucide-react";

import { useInsightsAnalytics } from "@/hooks/use-insights-analytics";
import { useTranslations } from "@/lib/i18n/context";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeading } from "@/components/insights/section-heading";
import { DeviceScoreTile } from "@/components/insights/device-score-tile";
import { DeviceScoreGridSkeleton } from "@/components/insights/device-score-tile-skeleton";

interface TileSpec {
  type: string;
  title: string;
  icon: typeof Activity;
  color: string;
  unit?: string;
  fractionDigits?: number;
}

interface TileGroup {
  key: string;
  headingIcon: typeof Activity;
  title: string;
  subtitle: string;
  tiles: TileSpec[];
}

/**
 * v1.17.1 — body of the `/insights/recovery` sub-page.
 *
 * The home for the WHOOP / Polar device-native recovery + strain scores that
 * were ingested but had no render host: day strain, workout strain, ANS charge,
 * cardio load, plus the day's whole-cycle average / max heart rate and the
 * kilojoule energy-expenditure figure. The composite RECOVERY_SCORE keeps its
 * own anatomy view at `/insights/scores/recovery`; this page cross-links to it
 * rather than duplicating the ring, and surrounds it with the raw device
 * signals it never showed.
 *
 * Each tile is data-gated (`<DeviceScoreTile>` returns null at count 0) and
 * each group hides when none of its tiles has data, so a non-wearable account
 * sees only the calm empty state below. Reads the shared analytics summaries
 * slice (no extra round-trip); server-authoritative throughout.
 */
export function RecoverySection() {
  const { t } = useTranslations();
  const { data, isLoading } = useInsightsAnalytics("SLEEP_DURATION");

  const summaries = data?.summaries;

  const groups: TileGroup[] = [
    {
      key: "recharge",
      headingIcon: Battery,
      title: t("insights.recovery.recharge.title"),
      subtitle: t("insights.recovery.recharge.subtitle"),
      tiles: [
        {
          type: "ANS_CHARGE",
          title: t("measurements.typeAnsCharge"),
          icon: Battery,
          color: "#50fa7b",
          unit: t("insights.deviceScore.unitScore"),
          fractionDigits: 1,
        },
      ],
    },
    {
      key: "strain",
      headingIcon: Gauge,
      title: t("insights.recovery.strain.title"),
      subtitle: t("insights.recovery.strain.subtitle"),
      tiles: [
        {
          type: "DAY_STRAIN",
          title: t("measurements.typeDayStrain"),
          icon: Gauge,
          color: "#ffb86c",
          unit: t("insights.deviceScore.unitScore"),
          fractionDigits: 1,
        },
        {
          type: "WORKOUT_STRAIN",
          title: t("measurements.typeWorkoutStrain"),
          icon: Activity,
          color: "#ff79c6",
          unit: t("insights.deviceScore.unitScore"),
          fractionDigits: 1,
        },
        {
          type: "CARDIO_LOAD",
          title: t("measurements.typeCardioLoad"),
          icon: TrendingUp,
          color: "#bd93f9",
          unit: t("insights.deviceScore.unitScore"),
        },
      ],
    },
    {
      key: "cardio",
      headingIcon: HeartPulse,
      title: t("insights.recovery.cardio.title"),
      subtitle: t("insights.recovery.cardio.subtitle"),
      tiles: [
        {
          type: "AVERAGE_HEART_RATE",
          title: t("measurements.typeAverageHeartRate"),
          icon: Heart,
          color: "#8be9fd",
          unit: t("insights.deviceScore.unitBpm"),
        },
        {
          type: "MAX_HEART_RATE",
          title: t("measurements.typeMaxHeartRate"),
          icon: HeartPulse,
          color: "#ff5555",
          unit: t("insights.deviceScore.unitBpm"),
        },
        {
          type: "ENERGY_EXPENDITURE_KJ",
          title: t("measurements.typeEnergyExpenditureKj"),
          icon: Flame,
          color: "#f1fa8c",
          unit: t("insights.deviceScore.unitKj"),
        },
      ],
    },
  ];

  const hasAny =
    summaries != null &&
    groups.some((group) =>
      group.tiles.some((tile) => (summaries[tile.type]?.count ?? 0) > 0),
    );

  const hasRecoveryScore = (summaries?.RECOVERY_SCORE?.count ?? 0) > 0;

  if (isLoading || summaries == null) {
    return (
      <div className="space-y-3" data-slot="recovery-loading">
        <SectionHeading
          icon={Battery}
          title={t("insights.recovery.recharge.title")}
        />
        <DeviceScoreGridSkeleton count={2} />
      </div>
    );
  }

  if (!hasAny && !hasRecoveryScore) {
    return (
      <EmptyState
        data-slot="recovery-empty"
        icon={<Heart className="size-6" />}
        title={t("insights.recovery.emptyTitle")}
        description={t("insights.recovery.empty")}
      />
    );
  }

  return (
    <div className="space-y-8" data-slot="recovery-section">
      {hasRecoveryScore ? (
        <Link
          href="/insights/scores/recovery"
          data-slot="recovery-score-link"
          className="bg-card border-border hover:bg-accent/40 flex items-center justify-between gap-3 rounded-xl border p-4 transition-colors"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Heart
              className="text-muted-foreground h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                {t("insights.recovery.scoreLink.title")}
              </span>
              <span className="text-muted-foreground block text-xs">
                {t("insights.recovery.scoreLink.subtitle")}
              </span>
            </span>
          </span>
          <span className="text-muted-foreground shrink-0 text-xs">
            {t("insights.recovery.scoreLink.cta")}
          </span>
        </Link>
      ) : null}

      {groups.map((group) => {
        const present =
          summaries == null
            ? []
            : group.tiles.filter(
                (tile) => (summaries[tile.type]?.count ?? 0) > 0,
              );
        if (present.length === 0) return null;
        return (
          <section
            key={group.key}
            data-slot={`recovery-group-${group.key}`}
            className="space-y-3"
          >
            <SectionHeading
              icon={group.headingIcon}
              title={group.title}
              action={
                <p className="text-muted-foreground text-xs">
                  {group.subtitle}
                </p>
              }
            />
            <div className="grid gap-4 sm:grid-cols-2">
              {present.map((tile) => (
                <DeviceScoreTile
                  key={tile.type}
                  type={tile.type}
                  summary={summaries?.[tile.type]}
                  title={tile.title}
                  icon={tile.icon}
                  color={tile.color}
                  unit={tile.unit}
                  fractionDigits={tile.fractionDigits}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
