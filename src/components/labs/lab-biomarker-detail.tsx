"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Pencil, Plus, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";

import { DeleteButton } from "@/components/data-list";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { apiDelete, apiGet, apiPut } from "@/lib/api/api-fetch";
import { BIOMARKER_CATALOG } from "@/lib/labs/biomarker-catalog";
import { classifyReferenceRange } from "@/lib/labs/reference-range";
import { formatLabValue } from "@/lib/labs/format-value";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import { ChartErrorBoundary } from "@/components/charts/chart-error-state";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { importWithRetry } from "@/lib/retry-import";

import { BiomarkerForm } from "./biomarker-form";
import { LabForm } from "./lab-form";
import { LabHistoryList } from "./lab-history-list";
import { ReferenceRangeBadge } from "./reference-range-badge";
import type {
  BiomarkerDto,
  LabResultDto,
  LabResultListResponse,
} from "./types";

// v1.18.11 (W5 perf) — defer the recharts biomarker chart through
// `next/dynamic` so recharts is off `/labs/[biomarkerId]`'s first-load JS.
// The chart only paints once the reading list resolves; the `<ChartSkeleton>`
// loading shell matches the in-card chart footprint so the layout is stable.
const LabBiomarkerChartLazy = dynamic(
  () =>
    importWithRetry(() => import("./lab-biomarker-chart")).then((mod) => ({
      default: mod.LabBiomarkerChart,
    })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
function LabBiomarkerChart(
  props: ComponentProps<typeof LabBiomarkerChartLazy>,
) {
  return (
    <ChartErrorBoundary>
      <LabBiomarkerChartLazy {...props} />
    </ChartErrorBoundary>
  );
}

/**
 * v1.18.1 — per-biomarker detail: heading + current-value badge, the proper
 * dashboard-style chart with the reference band, and the editable reading
 * history. "Add value" pre-selects this biomarker so the user never re-picks
 * it. Mirrors the measurement-detail layout.
 */
export function LabBiomarkerDetail({ biomarkerId }: { biomarkerId: string }) {
  const { t } = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();
  // v1.24 — the per-marker description used to live on the labs overview rows.
  // It belongs on the detail page beneath the heading (mirroring the metric
  // pages' explainer caption). Resolve the catalog slug from the marker name
  // exactly as the overview did, then fall back to the user's own `context`.
  const slugByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const seed of BIOMARKER_CATALOG) {
      const norm = t(`labs.catalog.${seed.slug}`).trim().toLowerCase();
      if (norm) map.set(norm, seed.slug);
    }
    return map;
  }, [t]);
  const [addOpen, setAddOpen] = useState(false);
  // Sticky-footer slot for the add-value sheet (the form portals here).
  const [addFooterEl, setAddFooterEl] = useState<HTMLDivElement | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editFooterEl, setEditFooterEl] = useState<HTMLDivElement | null>(null);
  // v1.24 — focused "adjust target range" sheet. Edits only the reference
  // bounds (the full marker editor lives behind the pencil); seeded from the
  // marker each time it opens.
  const [rangeOpen, setRangeOpen] = useState(false);
  const [lowerInput, setLowerInput] = useState("");
  const [upperInput, setUpperInput] = useState("");

  const { data: marker, isError: markerError } = useQuery({
    queryKey: queryKeys.biomarkerDetail(biomarkerId),
    queryFn: () => apiGet<BiomarkerDto>(`/api/biomarkers/${biomarkerId}`),
  });

  const {
    data: list,
    isLoading,
    isError: listError,
  } = useQuery({
    queryKey: queryKeys.labResultsList({
      biomarkerId,
      analyte: undefined,
      panel: undefined,
      from: undefined,
      to: undefined,
      page: 0,
      sortDir: "desc",
    }),
    queryFn: () =>
      apiGet<LabResultListResponse>(
        `/api/labs?biomarkerId=${encodeURIComponent(biomarkerId)}&limit=500&sortDir=desc`,
      ),
  });

  const readings: LabResultDto[] = list?.results ?? [];
  // The reading feed caps at 500 server-side; surface a hint when truncated.
  const total = list?.meta?.total ?? 0;
  const truncated = total > readings.length;
  const latest =
    readings.length > 0
      ? [...readings].sort(
          (a, b) =>
            new Date(b.takenAt).getTime() - new Date(a.takenAt).getTime(),
        )[0]
      : null;

  function afterAdd() {
    setAddOpen(false);
    queryClient.invalidateQueries({ queryKey: queryKeys.labResults() });
  }

  function afterEditMarker() {
    setEditOpen(false);
    queryClient.invalidateQueries({
      queryKey: queryKeys.biomarkerDetail(biomarkerId),
    });
    queryClient.invalidateQueries({ queryKey: queryKeys.biomarkers() });
    // Resolved name / unit / range on every reading derives from the marker.
    queryClient.invalidateQueries({ queryKey: queryKeys.labResults() });
  }

  // v1.18.9 (#41/#3) — delete the biomarker directly from its detail page so
  // a stray marker is removable without a Settings detour. `onDelete: SetNull`
  // keeps the readings and unlinks them. On success, invalidate the catalog +
  // result list and return to the labs surface.
  const deleteMarker = useMutation({
    mutationFn: () => apiDelete(`/api/biomarkers/${biomarkerId}`),
    onSuccess: () => {
      toast.success(t("labs.biomarker.deletedToast"));
      queryClient.invalidateQueries({ queryKey: queryKeys.biomarkers() });
      queryClient.invalidateQueries({ queryKey: queryKeys.labResults() });
      router.push("/labs");
    },
    onError: () => toast.error(t("labs.biomarker.deleteError")),
  });

  function openRange() {
    setLowerInput(marker?.lowerBound != null ? String(marker.lowerBound) : "");
    setUpperInput(marker?.upperBound != null ? String(marker.upperBound) : "");
    setRangeOpen(true);
  }

  const saveRange = useMutation({
    mutationFn: () => {
      const lower = lowerInput.trim() === "" ? null : Number(lowerInput);
      const upper = upperInput.trim() === "" ? null : Number(upperInput);
      return apiPut(`/api/biomarkers/${biomarkerId}`, {
        lowerBound: lower,
        upperBound: upper,
      });
    },
    onSuccess: () => {
      toast.success(t("labs.biomarker.targetRange.savedToast"));
      setRangeOpen(false);
      queryClient.invalidateQueries({
        queryKey: queryKeys.biomarkerDetail(biomarkerId),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.biomarkers() });
      queryClient.invalidateQueries({ queryKey: queryKeys.labResults() });
    },
    onError: () => toast.error(t("labs.biomarker.targetRange.saveError")),
  });

  if (markerError || listError) {
    return (
      <p className="text-destructive py-8 text-center text-sm">
        {t("labs.loadError")}
      </p>
    );
  }

  // A qualitative latest reading (numeric value null) has no range verdict.
  const latestStatus =
    latest && latest.value !== null
      ? classifyReferenceRange(
          latest.value,
          marker?.lowerBound ?? null,
          marker?.upperBound ?? null,
        )
      : "unknown";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">
            {marker?.name ?? <Skeleton className="h-7 w-32" />}
          </h1>
          {marker?.unit ? (
            <p className="text-muted-foreground text-xs sm:text-sm">
              {marker.unit}
              {marker.panel ? ` · ${marker.panel}` : ""}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
            onClick={() => setEditOpen(true)}
            disabled={!marker}
            aria-label={t("labs.biomarker.edit")}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <DeleteButton
            onConfirm={() => deleteMarker.mutate()}
            title={t("labs.biomarker.deleteConfirmTitle")}
            description={t("labs.biomarker.deleteConfirmDescription")}
            confirmLabel={t("labs.biomarker.delete")}
            className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
            iconClassName="h-4 w-4"
          />
          <Button
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
            onClick={openRange}
            disabled={!marker}
            aria-label={t("labs.biomarker.targetRange.title")}
          >
            <SlidersHorizontal className="h-4 w-4" />
          </Button>
          <Button
            onClick={() => setAddOpen(true)}
            // v1.18.10 (W10) — on the narrowest phones the h1 + Edit + Delete +
            // text "Add" button crowd the row and truncate the title hard.
            // Drop the Add button to icon-only under `sm` (label kept for
            // screen readers via `aria-label`); the full text returns at `sm+`.
            className="min-h-11 min-w-11 shrink-0 sm:min-h-9 sm:min-w-0"
            aria-label={t("labs.addResult")}
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">{t("labs.addResult")}</span>
          </Button>
        </div>
      </div>

      {latest ? (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-2xl font-bold tabular-nums">
            {latest.value !== null ? (
              <>
                {formatLabValue(latest.value)}{" "}
                <span className="text-muted-foreground text-base font-normal">
                  {marker?.unit ?? latest.unit}
                </span>
              </>
            ) : (
              // Qualitative latest reading — show the result text, no unit.
              (latest.valueText ?? "")
            )}
          </span>
          <ReferenceRangeBadge status={latestStatus} />
        </div>
      ) : null}

      {(() => {
        const slug = marker?.name
          ? slugByName.get(marker.name.trim().toLowerCase())
          : undefined;
        const description = slug
          ? t(`labs.catalog.desc.${slug}`)
          : (marker?.context ?? null);
        return description ? (
          <p className="text-muted-foreground text-sm leading-relaxed">
            {description}
          </p>
        ) : null;
      })()}

      <Card>
        <CardContent className="pt-6">
          {isLoading ? (
            <Skeleton className="h-60 w-full" />
          ) : readings.length === 0 ? (
            <EmptyState
              icon={<FlaskConical className="size-6" />}
              title={t("labs.detail.emptyTitle")}
              description={t("labs.detail.emptyDescription")}
              action={
                <Button onClick={() => setAddOpen(true)}>
                  {t("labs.addResult")}
                </Button>
              }
            />
          ) : (
            <LabBiomarkerChart
              readings={readings}
              unit={marker?.unit ?? latest?.unit ?? ""}
              lowerBound={marker?.lowerBound ?? null}
              upperBound={marker?.upperBound ?? null}
            />
          )}
        </CardContent>
      </Card>

      {readings.length > 0 ? (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold">{t("labs.detail.history")}</h2>
          {truncated ? (
            <p className="text-muted-foreground text-xs">
              {t("labs.showingLatestOf", {
                shown: readings.length,
                total,
              })}
            </p>
          ) : null}
          <Card>
            <CardContent className="py-0">
              <LabHistoryList readings={readings} />
            </CardContent>
          </Card>
        </div>
      ) : null}

      <ResponsiveSheet
        open={addOpen}
        onOpenChange={setAddOpen}
        title={t("labs.addResult")}
        description={t("labs.addDescription")}
        footer={
          <div ref={setAddFooterEl} className="flex w-full justify-end gap-2" />
        }
      >
        <LabForm
          lockedBiomarkerId={biomarkerId}
          footerSlot={addFooterEl}
          onSuccess={afterAdd}
          onCancel={() => setAddOpen(false)}
        />
      </ResponsiveSheet>

      <ResponsiveSheet
        open={editOpen}
        onOpenChange={setEditOpen}
        title={t("labs.biomarker.editTitle")}
        description={t("labs.biomarker.defineDescription")}
        footer={
          <div
            ref={setEditFooterEl}
            className="flex w-full justify-end gap-2"
          />
        }
      >
        {marker ? (
          <BiomarkerForm
            existing={marker}
            footerSlot={editFooterEl}
            onSuccess={afterEditMarker}
            onCancel={() => setEditOpen(false)}
          />
        ) : null}
      </ResponsiveSheet>

      <ResponsiveSheet
        open={rangeOpen}
        onOpenChange={setRangeOpen}
        title={t("labs.biomarker.targetRange.title")}
        description={t("labs.biomarker.targetRange.description")}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setRangeOpen(false)}
              disabled={saveRange.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => saveRange.mutate()}
              disabled={saveRange.isPending}
            >
              {t("labs.biomarker.targetRange.save")}
            </Button>
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="biomarker-lower-bound">
              {t("labs.biomarker.form.lowerBound")}
            </Label>
            <Input
              id="biomarker-lower-bound"
              type="number"
              inputMode="decimal"
              value={lowerInput}
              onChange={(e) => setLowerInput(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="biomarker-upper-bound">
              {t("labs.biomarker.form.upperBound")}
            </Label>
            <Input
              id="biomarker-upper-bound"
              type="number"
              inputMode="decimal"
              value={upperInput}
              onChange={(e) => setUpperInput(e.target.value)}
            />
          </div>
        </div>
        {marker?.unit ? (
          <p className="text-muted-foreground mt-2 text-xs">
            {t("labs.biomarker.form.rangeHint")}
          </p>
        ) : null}
      </ResponsiveSheet>
    </div>
  );
}
