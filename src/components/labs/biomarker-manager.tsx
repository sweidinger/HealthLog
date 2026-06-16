"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";

import { DeleteButton } from "@/components/data-list";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { apiDelete, apiGet } from "@/lib/api/api-fetch";
import { formatReferenceRange } from "@/lib/labs/reference-range";
import { formatLabValue } from "@/lib/labs/format-value";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { BiomarkerForm } from "./biomarker-form";
import type { BiomarkerDto, BiomarkerListResponse } from "./types";

/**
 * v1.18.1 — the Biomarker catalog manager.
 *
 * Lives on the Labs page (not Settings) because the catalog IS the Labs
 * feature's primary object. Lists every defined marker with its unit +
 * reference range, opens a define-new / edit sheet, and wires delete (the
 * `onDelete: SetNull` FK keeps existing readings, just unlinks them).
 */
export function BiomarkerManager() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<BiomarkerDto | null>(null);
  const [formFooterEl, setFormFooterEl] = useState<HTMLDivElement | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.biomarkers(),
    queryFn: () => apiGet<BiomarkerListResponse>("/api/biomarkers"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/biomarkers/${id}`),
    onSuccess: () => {
      toast.success(t("labs.biomarker.deletedToast"));
      queryClient.invalidateQueries({ queryKey: queryKeys.biomarkers() });
      queryClient.invalidateQueries({ queryKey: queryKeys.labResults() });
    },
    onError: () => toast.error(t("labs.biomarker.deleteError")),
  });

  function openNew() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(marker: BiomarkerDto) {
    setEditing(marker);
    setFormOpen(true);
  }

  function afterSave() {
    setFormOpen(false);
    setEditing(null);
    queryClient.invalidateQueries({ queryKey: queryKeys.biomarkers() });
    queryClient.invalidateQueries({ queryKey: queryKeys.labResults() });
  }

  const markers = data?.biomarkers ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          {t("labs.biomarker.managerDescription")}
        </p>
        <Button size="sm" onClick={openNew} className="shrink-0">
          <Plus className="h-4 w-4" />
          {t("labs.biomarker.define")}
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : isError ? (
        <p className="text-destructive py-6 text-center text-sm">
          {t("labs.biomarker.loadError")}
        </p>
      ) : markers.length === 0 ? (
        <EmptyState
          icon={<FlaskConical className="size-6" />}
          title={t("labs.biomarker.emptyTitle")}
          description={t("labs.biomarker.emptyDescription")}
          action={
            <Button onClick={openNew}>{t("labs.biomarker.defineFirst")}</Button>
          }
        />
      ) : (
        <ul className="space-y-2">
          {markers.map((marker) => {
            const range = formatReferenceRange(
              marker.lowerBound,
              marker.upperBound,
              formatLabValue,
            );
            return (
              <li key={marker.id}>
                <Card>
                  <CardContent className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="truncate text-sm font-medium">
                          {marker.name}
                        </span>
                        <span className="text-muted-foreground text-xs">
                          {marker.unit}
                        </span>
                      </div>
                      <p className="text-muted-foreground text-xs">
                        {range
                          ? `${t("labs.referenceLabel")} ${range} ${marker.unit}`
                          : t("labs.biomarker.noRange")}
                        {marker.panel ? ` · ${marker.panel}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-9"
                        onClick={() => openEdit(marker)}
                        aria-label={t("labs.biomarker.edit")}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <DeleteButton
                        onConfirm={() => deleteMutation.mutate(marker.id)}
                        title={t("labs.biomarker.deleteConfirmTitle")}
                        description={t(
                          "labs.biomarker.deleteConfirmDescription",
                        )}
                        confirmLabel={t("labs.biomarker.delete")}
                        className="size-9"
                        iconClassName="h-4 w-4"
                      />
                    </div>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <ResponsiveSheet
        open={formOpen}
        onOpenChange={setFormOpen}
        title={
          editing
            ? t("labs.biomarker.editTitle")
            : t("labs.biomarker.defineTitle")
        }
        description={t("labs.biomarker.defineDescription")}
        footer={
          <div ref={setFormFooterEl} className="flex w-full justify-end gap-2" />
        }
      >
        <BiomarkerForm
          existing={editing ?? undefined}
          footerSlot={formFooterEl}
          onSuccess={afterSave}
          onCancel={() => setFormOpen(false)}
        />
      </ResponsiveSheet>
    </div>
  );
}
