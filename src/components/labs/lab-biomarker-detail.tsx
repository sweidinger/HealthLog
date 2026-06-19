"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Pencil, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api/api-fetch";
import { classifyReferenceRange } from "@/lib/labs/reference-range";
import { formatLabValue } from "@/lib/labs/format-value";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { BiomarkerForm } from "./biomarker-form";
import { LabBiomarkerChart } from "./lab-biomarker-chart";
import { LabForm } from "./lab-form";
import { LabHistoryList } from "./lab-history-list";
import { ReferenceRangeBadge } from "./reference-range-badge";
import type {
  BiomarkerDto,
  LabResultDto,
  LabResultListResponse,
} from "./types";

/**
 * v1.18.1 — per-biomarker detail: heading + current-value badge, the proper
 * dashboard-style chart with the reference band, and the editable reading
 * history. "Add value" pre-selects this biomarker so the user never re-picks
 * it. Mirrors the measurement-detail layout.
 */
export function LabBiomarkerDetail({ biomarkerId }: { biomarkerId: string }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  // Sticky-footer slot for the add-value sheet (the form portals here).
  const [addFooterEl, setAddFooterEl] = useState<HTMLDivElement | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editFooterEl, setEditFooterEl] = useState<HTMLDivElement | null>(null);

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

  if (markerError || listError) {
    return (
      <p className="text-destructive py-8 text-center text-sm">
        {t("labs.loadError")}
      </p>
    );
  }

  const latestStatus = latest
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
          <Button
            onClick={() => setAddOpen(true)}
            className="min-h-11 shrink-0 sm:min-h-9"
          >
            <Plus className="h-4 w-4" />
            {t("labs.addResult")}
          </Button>
        </div>
      </div>

      {latest ? (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-2xl font-bold tabular-nums">
            {formatLabValue(latest.value)}{" "}
            <span className="text-muted-foreground text-base font-normal">
              {marker?.unit ?? latest.unit}
            </span>
          </span>
          <ReferenceRangeBadge status={latestStatus} />
        </div>
      ) : null}

      {marker?.context ? (
        <p className="text-muted-foreground text-sm">{marker.context}</p>
      ) : null}

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
    </div>
  );
}
