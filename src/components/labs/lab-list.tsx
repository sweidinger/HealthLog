"use client";

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import { toast } from "sonner";

import { DeleteButton } from "@/components/data-list";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { apiDelete, apiGet } from "@/lib/api/api-fetch";
import { formatDate } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { LabTrendSparkline } from "./lab-trend-sparkline";
import { ReferenceRangeBadge } from "./reference-range-badge";
import type { LabResultDto, LabResultListResponse } from "./types";

interface AnalyteGroup {
  analyte: string;
  panel: string | null;
  unit: string;
  /** All readings for this analyte, oldest → newest. */
  readings: LabResultDto[];
  latest: LabResultDto;
}

/** Reduce the flat result list into per-analyte groups (case-insensitive). */
function groupByAnalyte(results: LabResultDto[]): AnalyteGroup[] {
  const byKey = new Map<string, LabResultDto[]>();
  for (const r of results) {
    const key = r.analyte.toLowerCase();
    const existing = byKey.get(key);
    if (existing) existing.push(r);
    else byKey.set(key, [r]);
  }
  const groups: AnalyteGroup[] = [];
  for (const readings of byKey.values()) {
    // Ascending by takenAt so the sparkline reads left→right in time and
    // the last element is the latest.
    const ordered = [...readings].sort(
      (a, b) =>
        new Date(a.takenAt).getTime() - new Date(b.takenAt).getTime(),
    );
    const latest = ordered[ordered.length - 1];
    groups.push({
      analyte: latest.analyte,
      panel: latest.panel,
      unit: latest.unit,
      readings: ordered,
      latest,
    });
  }
  // Group order: most-recently-updated analyte first.
  return groups.sort(
    (a, b) =>
      new Date(b.latest.takenAt).getTime() -
      new Date(a.latest.takenAt).getTime(),
  );
}

function formatValue(value: number): string {
  // Trim trailing zeros for whole numbers; keep up to 2 decimals otherwise.
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

export function LabList({ onAddFirst }: { onAddFirst?: () => void } = {}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const listKey = queryKeys.labResultsList({
    analyte: undefined,
    panel: undefined,
    from: undefined,
    to: undefined,
    page: 0,
    sortDir: "desc",
  });

  const { data, isLoading, isError } = useQuery({
    queryKey: listKey,
    queryFn: async () => {
      const res = await apiGet<LabResultListResponse>(
        "/api/labs?limit=500&sortDir=desc",
      );
      return res;
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/labs/${id}`),
    onSuccess: () => {
      toast.success(t("labs.deletedToast"));
      queryClient.invalidateQueries({ queryKey: queryKeys.labResults() });
    },
    onError: () => toast.error(t("labs.deleteError")),
  });

  const groups = useMemo(
    () => groupByAnalyte(data?.results ?? []),
    [data?.results],
  );

  if (isLoading) {
    return (
      <div className="space-y-3" data-slot="lab-list-loading">
        {Array.from({ length: 3 }, (_, i) => (
          <Card key={i} aria-hidden="true">
            <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
              <Skeleton className="h-8 w-24 self-end sm:self-center" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <p className="text-destructive py-8 text-center text-sm">
        {t("labs.loadError")}
      </p>
    );
  }

  if (groups.length === 0) {
    return (
      <EmptyState
        icon={<FlaskConical className="size-6" />}
        title={t("labs.emptyTitle")}
        description={t("labs.emptyDescription")}
        action={
          onAddFirst ? (
            <Button onClick={onAddFirst}>{t("labs.addFirst")}</Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <Card key={group.analyte.toLowerCase()}>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
              <span className="font-medium">{group.analyte}</span>
              {group.panel ? (
                <span className="text-muted-foreground text-xs font-normal">
                  {group.panel}
                </span>
              ) : null}
              <ReferenceRangeBadge status={group.latest.rangeStatus} />
            </CardTitle>
            <CardAction className="flex items-center gap-3">
              <LabTrendSparkline values={group.readings.map((r) => r.value)} />
              <DeleteButton
                onConfirm={() => deleteMutation.mutate(group.latest.id)}
                title={t("labs.deleteConfirmTitle")}
                description={t("labs.deleteConfirmDescription")}
                confirmLabel={t("labs.deleteLatest")}
                className="size-9"
                iconClassName="h-4 w-4"
              />
            </CardAction>
          </CardHeader>
          <CardContent>
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-sm">
              <span className="text-foreground font-semibold tabular-nums">
                {formatValue(group.latest.value)} {group.latest.unit}
              </span>
              {group.latest.referenceLow !== null ||
              group.latest.referenceHigh !== null ? (
                <span className="text-xs">
                  {t("labs.referenceLabel")}{" "}
                  {group.latest.referenceLow !== null &&
                  group.latest.referenceHigh !== null
                    ? `${formatValue(group.latest.referenceLow)}–${formatValue(group.latest.referenceHigh)}`
                    : group.latest.referenceHigh !== null
                      ? `≤ ${formatValue(group.latest.referenceHigh)}`
                      : `≥ ${formatValue(group.latest.referenceLow as number)}`}
                </span>
              ) : null}
              <span className="text-xs">
                {formatDate(group.latest.takenAt)}
              </span>
              {group.readings.length > 1 ? (
                <span className="text-xs">
                  {t("labs.readingsCount", {
                    count: group.readings.length,
                  })}
                </span>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
