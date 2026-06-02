"use client";

import { useMemo } from "react";
import { Gauge, HeartPulse, Scale } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { getUnitForType } from "@/lib/validations/measurement";
import {
  MEASUREMENT_TYPE_ICONS,
  MEASUREMENT_TYPE_LABEL_KEYS,
} from "@/components/measurements/measurement-list-meta";
import { SparklineDeltaTile } from "./sparkline-delta-tile";
import { CoverageMeter } from "./coverage-meter";
import { WellnessScores } from "./wellness-scores";
import { ProvenanceExplainer } from "./provenance-explainer";
import { METRIC_PROVENANCE } from "./standards";
import {
  useDerivedBatch,
  type DerivedBatchRead,
  type DerivedBatchToken,
} from "./use-derived-metric";
import type { TrendDirectionSentiment } from "@/lib/insights/trend-sentiment";
// Type-only — the compute payloads never drag the server graph into the bundle.
import type { VitalsBaselineValue } from "@/lib/insights/derived/baseline";
import type { FitnessAgeValue } from "@/lib/insights/derived/fitness-age";
import type { VascularAgeDeltaValue } from "@/lib/insights/derived/vascular-age";
import type { HrvBalanceValue } from "@/lib/insights/derived/hrv-balance";
import type { BmiValue } from "@/lib/insights/derived/bmi";
import type { CoincidentDeviationValue } from "@/lib/insights/derived/coincident-deviation";
import type { DerivedProvenance } from "@/lib/insights/derived/types";
import { AlertTriangle } from "lucide-react";

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
 *   - ok → the full value + framing line + a provenance ⓘ affordance.
 *
 * The whole grid (every vital tile AND the wellness-score strip) reads from
 * ONE batched `/api/insights/derived/batch` request, fanned out server-side
 * under a bounded limiter with the profile loaded once. This replaces the
 * cold-mount fan-out of 14+ independent requests sharing the Prisma pool —
 * the "app hangs then recovers" symptom (v1.9.1 / v1.4.49.1).
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

/**
 * Storage-unit → display-symbol overrides. `getUnitForType` returns the
 * canonical *storage* string (e.g. the literal "celsius"); a tile must show
 * the symbol a user reads ("°C"). Only the units whose storage string is not
 * already a display symbol need an entry — kg / bpm / ms / % / mg/dL render
 * fine as-is.
 */
const DISPLAY_UNIT_SYMBOL: Record<string, string> = {
  celsius: "°C",
  fahrenheit: "°F",
};

function displayUnit(type: string): string {
  const storage = getUnitForType(type);
  return DISPLAY_UNIT_SYMBOL[storage] ?? storage;
}

function vitalSentiment(type: string): TrendDirectionSentiment {
  if (UP_BAD_VITALS.has(type)) return "up-bad";
  if (UP_GOOD_VITALS.has(type)) return "up-good";
  return "neutral";
}

interface DashboardProps {
  enabled?: boolean;
  className?: string;
}

/** The provenance ⓘ explainer for one derived metric, wired from the map. */
function MetricProvenance({
  metric,
  provenance,
}: {
  metric: keyof typeof METRIC_PROVENANCE;
  provenance: DerivedProvenance;
}) {
  const { t } = useTranslations();
  const meta = METRIC_PROVENANCE[metric];
  const method = (
    <>
      {meta.caveatKey ? (
        <span className="text-warning block font-medium">{t(meta.caveatKey)}</span>
      ) : null}
      {t(meta.methodKey)}
    </>
  );
  return (
    <ProvenanceExplainer
      provenance={provenance}
      method={method}
      standard={meta.standard}
    />
  );
}

interface TileProps {
  read: DerivedBatchRead;
  isLoading: boolean;
}

/** A single personal-typical-range tile for one vital. */
function BaselineTile({
  type,
  read,
  isLoading,
}: TileProps & { type: string }) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const data = read<VitalsBaselineValue>({ metric: "VITALS_BASELINE", type });

  if (isLoading || !data) return null;
  // Absent → don't render the tile at all.
  if (data.status === "insufficient" && data.reason === "no_readings_in_window") {
    return null;
  }

  const Icon = MEASUREMENT_TYPE_ICONS[type] ?? Gauge;
  const labelKey = MEASUREMENT_TYPE_LABEL_KEYS[type];
  const label = labelKey ? t(labelKey) : type;
  const unit = displayUnit(type);

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
        provenance={
          <MetricProvenance metric="VITALS_BASELINE" provenance={data.provenance} />
        }
      />
    </div>
  );
}

/** Cardio-fitness band tile (VO₂max passthrough re-frame). */
function FitnessAgeTile({ read, isLoading }: TileProps) {
  const { t } = useTranslations();
  const data = read<FitnessAgeValue>({ metric: "FITNESS_AGE" });
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
        provenance={
          <MetricProvenance metric="FITNESS_AGE" provenance={data.provenance} />
        }
      />
    </div>
  );
}

/** Vascular-age delta tile (Withings passthrough re-frame). */
function VascularAgeTile({ read, isLoading }: TileProps) {
  const { t } = useTranslations();
  const data = read<VascularAgeDeltaValue>({ metric: "VASCULAR_AGE_DELTA" });
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
        provenance={
          <MetricProvenance
            metric="VASCULAR_AGE_DELTA"
            provenance={data.provenance}
          />
        }
      />
    </div>
  );
}

/** HRV (SDNN) balance tile (reuses the baseline engine). */
function HrvBalanceTile({ read, isLoading }: TileProps) {
  const { t } = useTranslations();
  const data = read<HrvBalanceValue>({ metric: "HRV_BALANCE" });
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
        provenance={
          <MetricProvenance metric="HRV_BALANCE" provenance={data.provenance} />
        }
      />
    </div>
  );
}

/** BMI tile (weight + height fallback). */
function BmiTile({ read, isLoading }: TileProps) {
  const { t } = useTranslations();
  const data = read<BmiValue>({ metric: "BMI" });
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
        provenance={
          <MetricProvenance metric="BMI" provenance={data.provenance} />
        }
      />
    </div>
  );
}

/**
 * Coincident-deviation flag tile — surfaces ONLY when the flag fired today
 * (≥ N vitals outside their personal band on the same day). Lists the
 * contributing vitals as plain text and carries the provenance affordance
 * (the Hampel/Leys median ± k·MAD basis + the descriptive-not-clinical
 * caveat). When the flag has not fired the tile un-mounts entirely — never
 * an alarming empty card.
 */
function CoincidentDeviationTile({ read, isLoading }: TileProps) {
  const { t } = useTranslations();
  const data = read<CoincidentDeviationValue>({
    metric: "COINCIDENT_DEVIATION",
  });
  if (isLoading || !data || data.status !== "ok" || !data.value) return null;
  const v = data.value;
  if (!v.fired || v.contributing.length === 0) return null;

  const names = v.contributing
    .map((d) => {
      const labelKey = MEASUREMENT_TYPE_LABEL_KEYS[d.type];
      return labelKey ? t(labelKey) : d.type;
    })
    .join(", ");

  return (
    <div
      data-slot="vitals-tile"
      data-metric="COINCIDENT_DEVIATION"
      data-state="fired"
      className="bg-card border-warning/40 flex h-full w-full min-w-0 flex-col gap-2 rounded-xl border p-4 md:p-6"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground truncate text-xs font-medium tracking-wide uppercase">
          {t("insights.derived.coincident.label")}
        </span>
        <MetricProvenance
          metric="COINCIDENT_DEVIATION"
          provenance={data.provenance}
        />
        <AlertTriangle className="text-warning h-4 w-4 shrink-0" />
      </div>
      <p className="text-foreground text-sm" data-slot="coincident-summary">
        {t("insights.derived.coincident.summary", {
          count: v.contributing.length,
        })}
      </p>
      <p className="text-muted-foreground text-xs leading-snug">
        {t("insights.derived.coincident.vitals", { list: names })}
      </p>
    </div>
  );
}

/**
 * The full set of tokens the dashboard reads in one batch — the five
 * wellness scores + the four derived re-frames + the coincident-deviation
 * flag + one baseline per vital (minus HRV, which has its own balance tile).
 */
function dashboardTokens(): DerivedBatchToken[] {
  const tokens: DerivedBatchToken[] = [
    { metric: "READINESS" },
    { metric: "SLEEP_SCORE" },
    { metric: "RECOVERY_SCORE" },
    { metric: "STRESS_SCORE" },
    { metric: "STRAIN_SCORE" },
    { metric: "FITNESS_AGE" },
    { metric: "VASCULAR_AGE_DELTA" },
    { metric: "HRV_BALANCE" },
    { metric: "BMI" },
    { metric: "COINCIDENT_DEVIATION" },
  ];
  for (const type of SECTION_VITALS) {
    if (type === "HEART_RATE_VARIABILITY") continue;
    tokens.push({ metric: "VITALS_BASELINE", type });
  }
  return tokens;
}

export function VitalsDashboard({ enabled = true, className }: DashboardProps) {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  const vitals = useMemo(() => SECTION_VITALS, []);
  const tokens = useMemo(() => dashboardTokens(), []);

  const batch = useDerivedBatch(tokens, {
    enabled: enabled && isAuthenticated,
  });
  const read = batch.read;
  const isLoading = batch.isLoading;
  const tileProps: TileProps = { read, isLoading };

  return (
    <div data-slot="vitals-dashboard-wrap" className={cn("space-y-6", className)}>
      <WellnessScores read={read} isLoading={isLoading} />
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
          <CoincidentDeviationTile {...tileProps} />
          <FitnessAgeTile {...tileProps} />
          <VascularAgeTile {...tileProps} />
          <HrvBalanceTile {...tileProps} />
          <BmiTile {...tileProps} />
          {vitals
            .filter((type) => type !== "HEART_RATE_VARIABILITY")
            .map((type) => (
              <BaselineTile key={type} type={type} {...tileProps} />
            ))}
        </div>
      </section>
    </div>
  );
}
