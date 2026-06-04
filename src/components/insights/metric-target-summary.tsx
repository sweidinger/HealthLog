"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Target } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";
import { convertGlucose, resolveGlucoseUnit } from "@/lib/glucose";
import { RangeBar } from "@/components/targets/range-bar";
import { ConsistencyStrip } from "@/components/targets/consistency-strip";
import { TargetStatusPill } from "@/components/targets/target-status-pill";
import { TargetEditSheet } from "@/components/targets/target-edit-sheet";
import { getTargetSourceLink } from "@/lib/targets/source-link";

/**
 * v1.8.0 → v1.8.5 — surface the per-metric target reference panel on each
 * insights category page, directly beneath the chart / assessment.
 *
 * The data is the `/api/insights/targets` payload, read through the
 * shared `queryKeys.insightsTargets()` cache so warm sessions pay
 * nothing and a cold sub-page warms the cache its siblings reuse. We
 * never recompute the ranges here: the route is the single source of
 * truth for the age-based ESH blood-pressure band, the WHO weight / BMI
 * band, the Karvonen pulse band, the AASM sleep band, the ADA / DDG
 * glucose bands, and the medication / mood targets.
 *
 * The panel is a compact reference panel carrying the full target
 * context:
 *
 *   • Row 1: target range string + `<TargetStatusPill>` + source link
 *            (the "what is the band / what is it based on" answer).
 *   • Row 2: `<RangeBar>` — where today's value sits inside the band
 *            (the spatial answer). BP renders the second diastolic bar.
 *   • Row 3: in-target share % + the 30-day average.
 *   • Row 4: `<ConsistencyStrip>` — the last seven days at a glance.
 *   • Footer: an "Adjust target range" button that opens the
 *            `<TargetEditSheet>` inline — this panel is the home of
 *            target editing.
 *
 * Each insights slug maps to one target `type`, except blood glucose
 * which maps to up to four per-context cards (fasting / postprandial /
 * random / bedtime) — those carry mg/dL canonical values that we convert
 * to the user's display unit.
 */

interface TargetRange {
  min: number;
  max: number;
}

interface TargetClassification {
  category: string;
  color: string;
}

interface TargetItem {
  type: string;
  label: string;
  current: number | null;
  average30: number | null;
  unit: string;
  range: TargetRange | null;
  classification: TargetClassification | null;
  source: string;
  daysInRange7d: number;
  daysLogged7d: number;
  daysInRange30d: number;
  daysLogged30d: number;
  insufficientData: boolean;
  consistency7d: ReadonlyArray<"in" | "near" | "out" | null>;
}

interface TargetsResponse {
  targets: TargetItem[];
  bpDiastolic: {
    current: number | null;
    average30: number | null;
    range: TargetRange | null;
  };
  profile?: {
    glucoseUnit?: string | null;
  };
}

/**
 * Map each insights category slug to the target `type` the route emits.
 * Slugs without a numeric target (HRV, oxygen saturation, body
 * temperature, active energy, workouts, resting HR) are absent — the
 * component renders nothing for them, so the sub-page collapses cleanly.
 *
 * Blood glucose is the one slug that fans out to several target types:
 * the route emits one card per logged context, so the summary renders a
 * reference panel for each.
 */
const SLUG_TO_TARGET_TYPE: Record<string, string> = {
  "blood-pressure": "BLOOD_PRESSURE",
  weight: "WEIGHT",
  bmi: "BMI",
  pulse: "PULSE",
  sleep: "SLEEP_DURATION",
  mood: "MOOD_SCORE",
  medications: "MEDICATION_COMPLIANCE",
};

/** Glucose context target types, in the route's emission order. */
const GLUCOSE_TARGET_TYPES = [
  "BLOOD_GLUCOSE_FASTING",
  "BLOOD_GLUCOSE_POSTPRANDIAL",
  "BLOOD_GLUCOSE_RANDOM",
  "BLOOD_GLUCOSE_BEDTIME",
];

interface MetricTargetSummaryProps {
  /** Insights category slug, e.g. `"blood-pressure"`. */
  slug: string;
}

/** Trim a trailing `.0` so whole-number bands read `120` not `120.0`. */
function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function MetricTargetSummary({ slug }: MetricTargetSummaryProps) {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();

  const isGlucose = slug === "blood-glucose";
  const targetType = SLUG_TO_TARGET_TYPE[slug];

  const { data } = useQuery({
    queryKey: queryKeys.insightsTargets(),
    queryFn: async () => {
      const res = await fetch("/api/insights/targets");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as TargetsResponse;
    },
    enabled: isAuthenticated && (targetType != null || isGlucose),
  });

  // No numeric target for this slug, or the payload hasn't resolved yet.
  if ((!targetType && !isGlucose) || !data) return null;

  // Glucose: one panel per logged context, converting the canonical
  // mg/dL values to the user's display unit. The route's per-context
  // labels are i18n keys, so resolve them.
  if (isGlucose) {
    const displayUnit = resolveGlucoseUnit(data.profile?.glucoseUnit ?? null);
    const convert = (v: number | null) =>
      v == null ? null : convertGlucose(v, displayUnit);
    const panels = GLUCOSE_TARGET_TYPES.map((type) =>
      data.targets.find((entry) => entry.type === type),
    )
      .filter((entry): entry is TargetItem => entry != null && entry.range != null)
      .map((entry) => ({
        ...entry,
        label: t(entry.label),
        unit: displayUnit,
        current: convert(entry.current),
        average30: convert(entry.average30),
        range: entry.range
          ? {
              min: convertGlucose(entry.range.min, displayUnit),
              max: convertGlucose(entry.range.max, displayUnit),
            }
          : null,
      }));

    if (panels.length === 0) return null;

    // Glucose fans out to up to four per-context panels. Each context
    // maps to its own editable threshold, so every panel carries its own
    // inline edit button rather than a single shared one.
    return (
      <div className="space-y-2" data-slot="metric-target-summary-group">
        {panels.map((panel) => (
          <TargetReferencePanel
            key={panel.type}
            target={panel}
            heading={panel.label}
          />
        ))}
      </div>
    );
  }

  const target = data.targets.find((entry) => entry.type === targetType);
  if (!target || !target.range) return null;

  return (
    <TargetReferencePanel
      target={target}
      bpDiastolic={
        targetType === "BLOOD_PRESSURE" ? data.bpDiastolic : undefined
      }
    />
  );
}

interface TargetReferencePanelProps {
  target: TargetItem;
  bpDiastolic?: TargetsResponse["bpDiastolic"];
  /** Optional sub-heading shown above the panel (used for glucose contexts). */
  heading?: string;
}

/**
 * One compact reference panel: range + status pill + source, a range
 * bar (plus a diastolic bar for BP), the in-target share + 30-day
 * average, the 7-day consistency strip, and the adjust-target link.
 * All fields come from the `/api/insights/targets` payload — nothing is
 * recomputed here.
 */
function TargetReferencePanel({
  target,
  bpDiastolic,
  heading,
}: TargetReferencePanelProps) {
  const { t } = useTranslations();

  // The per-metric editor lives here. The button below opens a
  // self-contained `<TargetEditSheet>`, seeded with this metric's
  // type / unit / range (and the diastolic range for BP). The sheet
  // writes `PUT /api/user/thresholds` and invalidates the
  // `insightsTargets()` cache on save, so the panel repaints in place.
  const [editOpen, setEditOpen] = useState(false);

  const { range, unit } = target;
  if (!range) return null;

  const isBp = target.type === "BLOOD_PRESSURE";
  const isMedicationCompliance = target.type === "MEDICATION_COMPLIANCE";

  // Compose the range string. Blood pressure stitches the systolic band
  // (on this target) with the diastolic band (on `bpDiastolic`) so the
  // user reads the familiar `S/D` pair.
  let rangeLabel: string;
  if (isBp && bpDiastolic?.range) {
    const dia = bpDiastolic.range;
    rangeLabel = t("insights.subPage.target.bpRange", {
      sysMin: fmt(range.min),
      sysMax: fmt(range.max),
      diaMin: fmt(dia.min),
      diaMax: fmt(dia.max),
      unit,
    });
  } else {
    rangeLabel = t("insights.subPage.target.range", {
      min: fmt(range.min),
      max: fmt(range.max),
      unit,
    });
  }

  const sourceLink = getTargetSourceLink(target);

  // In-target share: fraction of logged days in the green band over the
  // last 30. Suppressed when the route flagged insufficient data so the
  // sub-page suppresses the share line.
  const showShare = !target.insufficientData && target.daysLogged30d > 0;
  const sharePct = showShare
    ? Math.round((target.daysInRange30d / target.daysLogged30d) * 100)
    : null;

  // 30-day average. BP stitches the diastolic average into the familiar
  // `S/D` pair; everything else rounds to one decimal.
  let averageLabel: string | null = null;
  if (target.average30 != null) {
    const avgValue =
      isBp && bpDiastolic?.average30 != null
        ? `${Math.round(target.average30)}/${Math.round(bpDiastolic.average30)}`
        : String(Math.round(target.average30 * 10) / 10);
    averageLabel = `${t("targets.average30d")} ${avgValue} ${unit}`;
  }

  const showConsistency =
    !target.insufficientData &&
    target.consistency7d != null &&
    target.consistency7d.length > 0;

  return (
    <div
      data-slot="metric-target-summary"
      data-target-type={target.type}
      className="border-border/40 bg-card/20 space-y-3 rounded-lg border px-3 py-2.5"
    >
      {/* Row 1: target range string + status pill + source link. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <div className="flex items-center gap-2.5">
          <Target
            className="text-dracula-green size-4 shrink-0"
            aria-hidden="true"
          />
          <div className="space-y-0.5">
            {heading ? (
              <p className="text-muted-foreground text-[0.6875rem] font-medium tracking-[0.06em] uppercase">
                {heading}
              </p>
            ) : null}
            <p className="text-sm font-medium">{rangeLabel}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {target.classification ? (
            <TargetStatusPill
              classification={target.classification}
              range={range}
              unit={unit}
              source={target.source}
            />
          ) : null}
        </div>
      </div>

      {/* Row 2: range bar — where today's value sits inside the band. */}
      {target.current != null ? (
        <RangeBar
          value={target.current}
          min={range.min}
          max={range.max}
          unit={unit}
          orangeMin={isMedicationCompliance ? 70 : undefined}
          orangeMax={isMedicationCompliance ? 100 : undefined}
        />
      ) : null}

      {/* Row 2b: diastolic range bar for blood pressure. */}
      {isBp && bpDiastolic?.range && bpDiastolic.current != null ? (
        <div className="space-y-1">
          <p className="text-muted-foreground text-xs">
            {t("targets.diastolic")}
          </p>
          <RangeBar
            value={bpDiastolic.current}
            min={bpDiastolic.range.min}
            max={bpDiastolic.range.max}
            unit="mmHg"
          />
        </div>
      ) : null}

      {/* Row 3: in-target share + 30-day average. */}
      {sharePct != null || averageLabel ? (
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
          {sharePct != null ? (
            <span>
              {t("insights.subPage.target.inTargetShare", { pct: sharePct })}
            </span>
          ) : null}
          {averageLabel ? <span>{averageLabel}</span> : null}
        </div>
      ) : null}

      {/* Row 4: 7-day consistency strip. */}
      {showConsistency && target.consistency7d ? (
        <ConsistencyStrip
          days={target.consistency7d}
          daysInRange={target.daysInRange7d ?? 0}
          daysLogged={target.daysLogged7d ?? 0}
        />
      ) : null}

      {/* Footer: source link + inline adjust-target button. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 pt-0.5">
        {sourceLink ? (
          <a
            href={sourceLink}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
          >
            <span>{t("targets.sourceLabel", { source: target.source })}</span>
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        ) : (
          <span className="text-muted-foreground text-xs">
            {t("targets.sourceLabel", { source: target.source })}
          </span>
        )}
        <button
          type="button"
          onClick={() => setEditOpen(true)}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex min-h-11 items-center rounded-sm px-1 text-xs font-medium underline-offset-4 transition-colors hover:underline focus-visible:ring-2 focus-visible:outline-none"
          data-slot="metric-target-adjust"
        >
          {t("insights.subPage.target.adjustLink")}
        </button>
      </div>

      {/* v1.8.6 — inline target editor, mounted alongside the panel and
          portalled by the sheet primitive. The body only instantiates its
          TanStack Query hooks once `editOpen` is true (lazy mount inside
          the sheet), so closed panels stay cheap. */}
      <TargetEditSheet
        targetType={target.type}
        targetLabel={heading ?? target.label}
        unit={unit}
        initialRange={range}
        initialDiastolicRange={bpDiastolic?.range ?? null}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
    </div>
  );
}
