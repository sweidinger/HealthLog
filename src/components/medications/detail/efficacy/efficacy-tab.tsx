"use client";

/**
 * v1.28 — the "Wirkung" tab body: a strictly-descriptive, association-only
 * view relating a medication to the outcome metric(s)/lab(s) its class is
 * prescribed to move, around its start. Reads the server-authoritative
 * efficacy DTO (`GET /api/medications/[id]/efficacy`) and renders it — it
 * never recomputes a delta, mean, or adherence rate. No verdict, no score, no
 * "working / not working" language, no dose advice: the copy is numbers +
 * neutral connective phrasing only, mirroring the adherence-storyline posture.
 */
import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Activity, TrendingUp } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { MedicationDetailSection } from "@/components/medications/medication-detail-section";
import { TileHeader } from "@/components/insights/tile-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { queryKeys } from "@/lib/query-keys";
import { apiGet, apiPut } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { useAuth } from "@/hooks/use-auth";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import type {
  MedicationEfficacyDTO,
  EfficacyTargetView,
} from "@/lib/medications/efficacy/build-efficacy";

const EfficacyChart = dynamic(
  () =>
    import("@/components/charts/chart-runtime").then((mod) => ({
      default: mod.EfficacyChart,
    })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);

export function EfficacyTab({
  medicationId,
  active,
}: {
  medicationId: string;
  active: boolean;
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const timezone = user?.timezone || DEFAULT_TIMEZONE;
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.medicationEfficacy(medicationId),
    queryFn: () =>
      apiGet<MedicationEfficacyDTO>(
        `/api/medications/${medicationId}/efficacy`,
      ),
    enabled: active,
    staleTime: 60_000,
  });

  if (isLoading || !data) {
    return (
      <MedicationDetailSection
        titleId="medication-wirkung-heading"
        title={t("medications.efficacy.title")}
        dataSlot="medication-wirkung-section"
      >
        <ChartSkeleton />
      </MedicationDetailSection>
    );
  }

  // The tab is hidden upstream when ineligible; this is a defensive fallback.
  if (!data.eligible) {
    return (
      <MedicationDetailSection
        titleId="medication-wirkung-heading"
        title={t("medications.efficacy.title")}
        dataSlot="medication-wirkung-section"
      >
        <p className="text-muted-foreground text-sm">
          {t("medications.efficacy.notEligible")}
        </p>
      </MedicationDetailSection>
    );
  }

  return (
    <div className="space-y-6" data-slot="medication-wirkung-section">
      <MedicationDetailSection
        titleId="medication-wirkung-heading"
        title={t("medications.efficacy.title")}
        dataSlot="medication-wirkung-intro"
      >
        <div className="space-y-3">
          <p className="text-muted-foreground text-sm">
            {t("medications.efficacy.intro")}
          </p>
          {data.markers.startSource === "firstReading" ? (
            <p className="text-muted-foreground text-xs">
              {t("medications.efficacy.startFallback")}
            </p>
          ) : null}
          {data.markers.start === null ? (
            <p className="text-muted-foreground text-xs">
              {t("medications.efficacy.noStart")}
            </p>
          ) : null}
          <RetargetControl
            medicationId={medicationId}
            options={data.overrideOptions}
            isOverride={data.resolution.tier === "override"}
            onChanged={() =>
              queryClient.invalidateQueries({
                queryKey: queryKeys.medicationEfficacy(medicationId),
              })
            }
          />
        </div>
      </MedicationDetailSection>

      {data.targets.map((target) => (
        <TargetCard
          key={`${target.kind}:${target.key}`}
          target={target}
          dto={data}
          timezone={timezone}
        />
      ))}

      <p
        className="text-muted-foreground text-xs"
        data-slot="medication-wirkung-disclaimer"
      >
        {t("medications.efficacy.disclaimer")}
      </p>
    </div>
  );
}

function TargetCard({
  target,
  dto,
  timezone,
}: {
  target: EfficacyTargetView;
  dto: MedicationEfficacyDTO;
  timezone: string;
}) {
  const { t } = useTranslations();
  const startMs = dto.markers.start ? Date.parse(dto.markers.start) : null;

  return (
    <Card data-slot={`medication-wirkung-target-${target.kind}`}>
      <CardHeader>
        <TileHeader
          icon={TrendingUp}
          title={target.label}
          right={
            target.primary ? (
              <span className="text-muted-foreground text-xs">
                {t("medications.efficacy.primaryBadge")}
              </span>
            ) : undefined
          }
        />
      </CardHeader>
      <CardContent className="space-y-4">
        {target.series.length > 0 ? (
          <EfficacyChart
            target={{
              label: target.label,
              unit: target.unit,
              referenceBand: target.referenceBand,
              series: target.series.map((p) => ({ t: p.t, value: p.value })),
            }}
            startMs={startMs}
            doseChanges={dto.markers.doseChanges}
            pauses={dto.markers.pauses}
            adherence={dto.adherence.map((a) => ({
              date: a.date,
              rate: a.rate,
            }))}
            timezone={timezone}
            startLabel={t("medications.efficacy.startMarker")}
            adherenceLabel={t("medications.efficacy.adherenceLane")}
            typicalRangeLabel={t("medications.efficacy.typicalRange")}
          />
        ) : (
          <p className="text-muted-foreground text-sm">
            {t("medications.efficacy.noSeries")}
          </p>
        )}

        <BeforeAfterCard target={target} minWeeks={dto.minWeeksPerSide} />

        {target.levelShift?.present && target.levelShift.nearStart ? (
          <p
            className="text-muted-foreground text-xs"
            data-slot="medication-wirkung-levelshift"
          >
            {t("medications.efficacy.levelShift", {
              date: formatShort(target.levelShift.at),
            })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function BeforeAfterCard({
  target,
  minWeeks,
}: {
  target: EfficacyTargetView;
  minWeeks: number;
}) {
  const { t } = useTranslations();
  const ba = target.beforeAfter;
  const unit = target.unit ? ` ${target.unit}` : "";

  if (!ba.present || !ba.before || !ba.after || !ba.delta) {
    const reasonKey =
      ba.reason === "insufficient_before"
        ? "medications.efficacy.beforeAfter.needBefore"
        : ba.reason === "insufficient_after"
          ? "medications.efficacy.beforeAfter.needAfter"
          : ba.reason === "no_start"
            ? "medications.efficacy.beforeAfter.needStart"
            : "medications.efficacy.beforeAfter.needData";
    return (
      <div
        className="border-border/60 rounded-lg border border-dashed p-3"
        data-slot="medication-wirkung-beforeafter-empty"
      >
        <p className="text-muted-foreground text-sm">
          {t(reasonKey, { weeks: minWeeks })}
        </p>
      </div>
    );
  }

  const arrow = ba.delta.mean > 0 ? "+" : "";
  return (
    <div
      className="bg-muted/40 rounded-lg p-3"
      data-slot="medication-wirkung-beforeafter"
    >
      <p className="text-foreground text-sm">
        {t("medications.efficacy.beforeAfter.summary", {
          before: `${ba.before.mean}${unit}`,
          after: `${ba.after.mean}${unit}`,
          delta: `${arrow}${ba.delta.mean}${unit}`,
        })}
      </p>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("medications.efficacy.beforeAfter.counts", {
          beforeCount: ba.before.count,
          afterCount: ba.after.count,
        })}
      </p>
    </div>
  );
}

function RetargetControl({
  medicationId,
  options,
  isOverride,
  onChanged,
}: {
  medicationId: string;
  options: MedicationEfficacyDTO["overrideOptions"];
  isOverride: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslations();
  const [value, setValue] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const items = useMemo(
    () => [
      ...options.metrics.map((m) => ({
        value: `metric:${m.key}`,
        label: m.label,
      })),
      ...options.biomarkers.map((b) => ({
        value: `lab:${b.id}`,
        label: b.label,
      })),
    ],
    [options],
  );

  const apply = async (clear: boolean) => {
    setBusy(true);
    try {
      const body: {
        clear?: boolean;
        measurementType?: string;
        biomarkerId?: string;
      } = {};
      if (clear) {
        body.clear = true;
      } else if (value.startsWith("metric:")) {
        body.measurementType = value.slice("metric:".length);
      } else if (value.startsWith("lab:")) {
        body.biomarkerId = value.slice("lab:".length);
      } else {
        setBusy(false);
        return;
      }
      await apiPut(`/api/medications/${medicationId}/efficacy/target`, body);
      onChanged();
      if (clear) setValue("");
    } finally {
      setBusy(false);
    }
  };

  if (items.length === 0) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-slot="medication-wirkung-retarget"
    >
      <Activity aria-hidden="true" className="text-muted-foreground h-4 w-4" />
      <span className="text-muted-foreground text-xs">
        {t("medications.efficacy.retarget.label")}
      </span>
      <Select value={value} onValueChange={setValue}>
        <SelectTrigger size="sm" className="w-56">
          <SelectValue
            placeholder={t("medications.efficacy.retarget.placeholder")}
          />
        </SelectTrigger>
        <SelectContent>
          {items.map((it) => (
            <SelectItem key={it.value} value={it.value}>
              {it.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="outline"
        disabled={busy || value === ""}
        onClick={() => apply(false)}
      >
        {t("medications.efficacy.retarget.apply")}
      </Button>
      {isOverride ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => apply(true)}
        >
          {t("medications.efficacy.retarget.reset")}
        </Button>
      ) : null}
    </div>
  );
}

function formatShort(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}
