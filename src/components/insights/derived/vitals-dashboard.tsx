"use client";

import { useMemo } from "react";
import { Gauge, HeartPulse, Scale } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { getUnitForType } from "@/lib/validations/measurement";
import {
  MEASUREMENT_TYPE_ICONS,
  MEASUREMENT_TYPE_LABEL_KEYS,
} from "@/components/measurements/measurement-list-meta";
import { SparklineDeltaTile } from "./sparkline-delta-tile";
import { CoverageMeter } from "./coverage-meter";
import { WellnessScores } from "./wellness-scores";
import { useDerivedMetric } from "./use-derived-metric";
import type { TrendDirectionSentiment } from "@/lib/insights/trend-sentiment";
// Type-only — the compute payloads never drag the server graph into the bundle.
import type { VitalsBaselineValue } from "@/lib/insights/derived/baseline";
import type { FitnessAgeValue } from "@/lib/insights/derived/fitness-age";
import type { VascularAgeDeltaValue } from "@/lib/insights/derived/vascular-age";
import type { HrvBalanceValue } from "@/lib/insights/derived/hrv-balance";
import type { BmiValue } from "@/lib/insights/derived/bmi";

/**
 * v1.10.0 — the Vitals dashboard surface (Apple-Health-Highlights grid).
 *
 * A responsive grid of `SparklineDeltaTile`s, one per available vital, each
 * framed with its personal typical range (the flagship baseline metric) plus
 * the four passthrough/derived re-frames (cardio-fitness band, vascular-age
 * delta, HRV balance, BMI). Every tile is data-availability-gated:
 *   - absent (`no_readings_in_window` / `no_height` / `no_weight`) → the tile
 *     does not render at all (no apologetic empty card).
 *   - provisional (`insufficient_history_for_band`) → the tile renders with a
 *     `CoverageMeter` that shows the honest "N of 7 days" state, never a
 *     headline number from too-little history.
 *   - ok → the full value + framing line + sparkline placeholder.
 *
 * Each tile owns its own `useDerivedMetric` query (keyed off the centralised
 * factory) so a sparse vital simply un-mounts rather than blocking the grid.
 */

const SECTION_VITALS: string[] = [
  "RESTING_HEART_RATE",
  "HEART_RATE_VARIABILITY",
  "RESPIRATORY_RATE",
  "OXYGEN_SATURATION",
  "BODY_TEMPERATURE",
  "BLOOD_GLUCOSE",
  "WEIGHT",
];

/** Up-is-bad for the vitals where a rise is unfavourable. */
const UP_BAD_VITALS = new Set([
  "RESTING_HEART_RATE",
  "BODY_TEMPERATURE",
  "BLOOD_GLUCOSE",
  "WEIGHT",
]);
/** Up-is-good for the vitals where a rise is favourable. */
const UP_GOOD_VITALS = new Set(["HEART_RATE_VARIABILITY", "OXYGEN_SATURATION"]);

function vitalSentiment(type: string): TrendDirectionSentiment {
  if (UP_BAD_VITALS.has(type)) return "up-bad";
  if (UP_GOOD_VITALS.has(type)) return "up-good";
  return "neutral";
}

interface DashboardProps {
  enabled?: boolean;
  className?: string;
}

/** A single personal-typical-range tile for one vital. */
function BaselineTile({ type, enabled }: { type: string; enabled: boolean }) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { data, isLoading } = useDerivedMetric<VitalsBaselineValue>(
    "VITALS_BASELINE",
    { type, enabled },
  );

  if (isLoading || !data) return null;
  // Absent → don't render the tile at all.
  if (data.status === "insufficient" && data.reason === "no_readings_in_window") {
    return null;
  }

  const Icon = MEASUREMENT_TYPE_ICONS[type] ?? Gauge;
  const labelKey = MEASUREMENT_TYPE_LABEL_KEYS[type];
  const label = labelKey ? t(labelKey) : type;
  const unit = getUnitForType(type);

  // Provisional — building the band; show value-less coverage state.
  if (data.status === "insufficient") {
    return (
      <div
        data-slot="vitals-tile"
        data-metric={type}
        data-state="provisional"
        className="bg-card border-border flex h-full w-full min-w-0 flex-col gap-3 rounded-xl border p-4 md:p-6"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground truncate text-xs font-medium tracking-wide uppercase">
            {label}
          </span>
          <Icon className="text-muted-foreground h-4 w-4 shrink-0" />
        </div>
        <p className="text-muted-foreground text-sm" data-slot="vitals-tile-building">
          {t("insights.derived.vitals.building", {
            count: data.coverage.historyDays,
            target: 7,
          })}
        </p>
        <CoverageMeter coverage={data.coverage} />
      </div>
    );
  }

  const v = data.value!;
  const framing = t("insights.derived.vitals.typicalRange", {
    low: fmt.number(v.low, 1),
    high: fmt.number(v.high, 1),
  });

  return (
    <div data-slot="vitals-tile" data-metric={type} data-state="ok">
      <SparklineDeltaTile
        label={label}
        value={v.center}
        unit={unit}
        icon={Icon}
        framing={framing}
        directionSentiment={vitalSentiment(type)}
      />
    </div>
  );
}

/** Cardio-fitness band tile (VO₂max passthrough re-frame). */
function FitnessAgeTile({ enabled }: { enabled: boolean }) {
  const { t } = useTranslations();
  const { data, isLoading } = useDerivedMetric<FitnessAgeValue>("FITNESS_AGE", {
    enabled,
  });
  if (isLoading || !data || data.status !== "ok" || !data.value) return null;
  const v = data.value;
  const framing =
    v.fitnessAgeDeltaYears != null
      ? v.fitnessAgeDeltaYears < 0
        ? t("insights.derived.vitals.fitnessYounger", {
            years: Math.abs(v.fitnessAgeDeltaYears),
          })
        : v.fitnessAgeDeltaYears > 0
          ? t("insights.derived.vitals.fitnessOlder", {
              years: v.fitnessAgeDeltaYears,
            })
          : t("insights.derived.vitals.fitnessTypical")
      : t("insights.derived.vitals.fitnessNoNorm");
  return (
    <div data-slot="vitals-tile" data-metric="FITNESS_AGE" data-state="ok">
      <SparklineDeltaTile
        label={t("measurements.typeVo2Max")}
        value={v.vo2Max}
        unit={getUnitForType("VO2_MAX")}
        icon={Gauge}
        delta={v.trendDelta}
        directionSentiment="up-good"
        framing={framing}
        precision={1}
      />
    </div>
  );
}

/** Vascular-age delta tile (Withings passthrough re-frame). */
function VascularAgeTile({ enabled }: { enabled: boolean }) {
  const { t } = useTranslations();
  const { data, isLoading } = useDerivedMetric<VascularAgeDeltaValue>(
    "VASCULAR_AGE_DELTA",
    { enabled },
  );
  if (isLoading || !data || data.status !== "ok" || !data.value) return null;
  const v = data.value;
  const framing =
    v.deltaYears != null
      ? v.deltaYears < 0
        ? t("insights.derived.vitals.vascularBelow", {
            years: Math.abs(Math.round(v.deltaYears)),
          })
        : v.deltaYears > 0
          ? t("insights.derived.vitals.vascularAbove", {
              years: Math.round(v.deltaYears),
            })
          : t("insights.derived.vitals.vascularMatch")
      : t("insights.derived.vitals.vascularNoAge");
  return (
    <div data-slot="vitals-tile" data-metric="VASCULAR_AGE_DELTA" data-state="ok">
      <SparklineDeltaTile
        label={t("measurements.typeVascularAge")}
        value={v.vascularAge}
        unit={getUnitForType("VASCULAR_AGE")}
        icon={HeartPulse}
        delta={v.trendDelta}
        directionSentiment="up-bad"
        framing={framing}
        precision={0}
      />
    </div>
  );
}

/** HRV (SDNN) balance tile (reuses the baseline engine). */
function HrvBalanceTile({ enabled }: { enabled: boolean }) {
  const { t } = useTranslations();
  const { data, isLoading } = useDerivedMetric<HrvBalanceValue>("HRV_BALANCE", {
    enabled,
  });
  if (isLoading || !data) return null;
  if (data.status === "insufficient" && data.reason === "no_readings_in_window") {
    return null;
  }
  if (data.status === "insufficient") {
    return (
      <div
        data-slot="vitals-tile"
        data-metric="HRV_BALANCE"
        data-state="provisional"
        className="bg-card border-border flex h-full w-full min-w-0 flex-col gap-3 rounded-xl border p-4 md:p-6"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground truncate text-xs font-medium tracking-wide uppercase">
            {t("measurements.typeHeartRateVariability")}
          </span>
          <HeartPulse className="text-muted-foreground h-4 w-4 shrink-0" />
        </div>
        <p className="text-muted-foreground text-sm">
          {t("insights.derived.vitals.building", {
            count: data.coverage.historyDays,
            target: 7,
          })}
        </p>
        <CoverageMeter coverage={data.coverage} />
      </div>
    );
  }
  const v = data.value!;
  const framing = t(`insights.derived.vitals.hrvBand.${v.band}`);
  return (
    <div data-slot="vitals-tile" data-metric="HRV_BALANCE" data-state="ok">
      <SparklineDeltaTile
        label={t("measurements.typeHeartRateVariability")}
        value={v.recentAvg}
        unit={getUnitForType("HEART_RATE_VARIABILITY")}
        icon={HeartPulse}
        directionSentiment="up-good"
        framing={framing}
        precision={0}
      />
    </div>
  );
}

/** BMI tile (weight + height fallback). */
function BmiTile({ enabled }: { enabled: boolean }) {
  const { t } = useTranslations();
  const { data, isLoading } = useDerivedMetric<BmiValue>("BMI", { enabled });
  if (isLoading || !data || data.status !== "ok" || !data.value) return null;
  const v = data.value;
  const framing = t(`insights.derived.vitals.bmiCategory.${v.category}`);
  return (
    <div data-slot="vitals-tile" data-metric="BMI" data-state="ok">
      <SparklineDeltaTile
        label={t("measurements.typeBodyMassIndex")}
        value={v.bmi}
        unit={getUnitForType("BODY_MASS_INDEX")}
        icon={Scale}
        directionSentiment="neutral"
        framing={framing}
        precision={1}
      />
    </div>
  );
}

export function VitalsDashboard({ enabled = true, className }: DashboardProps) {
  const { t } = useTranslations();
  const vitals = useMemo(() => SECTION_VITALS, []);

  return (
    <div data-slot="vitals-dashboard-wrap" className={cn("space-y-6", className)}>
      <WellnessScores enabled={enabled} />
      <section
        data-slot="vitals-dashboard"
        aria-label={t("insights.derived.vitals.sectionTitle")}
        className="space-y-3"
      >
        <h2 className="text-foreground text-sm font-semibold tracking-tight">
          {t("insights.derived.vitals.sectionTitle")}
        </h2>
        <div
          data-slot="vitals-dashboard-grid"
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
        >
          <FitnessAgeTile enabled={enabled} />
          <VascularAgeTile enabled={enabled} />
          <HrvBalanceTile enabled={enabled} />
          <BmiTile enabled={enabled} />
          {vitals
            .filter((type) => type !== "HEART_RATE_VARIABILITY")
            .map((type) => (
              <BaselineTile key={type} type={type} enabled={enabled} />
            ))}
        </div>
      </section>
    </div>
  );
}
