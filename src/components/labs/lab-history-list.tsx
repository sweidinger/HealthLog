"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";

import { DeleteButton } from "@/components/data-list";
import { Button } from "@/components/ui/button";
import { DateTimeInput } from "@/components/ui/date-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, apiDelete, apiGet, apiPost, apiPut } from "@/lib/api/api-fetch";
import { formatDateShort } from "@/lib/format";
import { formatLabValue } from "@/lib/labs/format-value";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { ReferenceRangeBadge } from "./reference-range-badge";
import type { LabResultDetailDto, LabResultDto } from "./types";

const NOTE_MAX_LENGTH = 2000;

function toDateTimeLocal(iso: string): string {
  const d = new Date(iso);
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

function parseDecimal(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * v1.18.1 — reverse-chronological reading history for one biomarker, with
 * full edit / amend / delete (L5). Edit opens a sheet that loads the
 * decrypted note from the single-resource GET; delete soft-deletes with an
 * Undo toast that restores via `/api/labs/restore` (the measurement pattern).
 */
export function LabHistoryList({ readings }: { readings: LabResultDto[] }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editTakenAt, setEditTakenAt] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: queryKeys.labResults() });
  }

  async function restore(id: string) {
    try {
      await apiPost("/api/labs/restore", { ids: [id] });
      invalidate();
      toast.success(t("labs.restoredToast"));
    } catch {
      toast.error(t("labs.restoreError"));
    }
  }

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/labs/${id}`),
    onSuccess: (_data, id) => {
      invalidate();
      toast.success(t("labs.deletedToast"), {
        action: {
          label: t("common.undo"),
          onClick: () => void restore(id),
        },
      });
    },
    onError: () => toast.error(t("labs.deleteError")),
  });

  const updateMutation = useMutation({
    mutationFn: (body: {
      id: string;
      value: number;
      takenAt: string;
      note: string | null;
    }) =>
      apiPut<LabResultDto>(`/api/labs/${body.id}`, {
        value: body.value,
        takenAt: body.takenAt,
        note: body.note,
      }),
    onSuccess: () => {
      invalidate();
      toast.success(t("labs.editedToast"));
      closeEdit();
    },
    onError: (err) => {
      setEditError(
        err instanceof ApiError ? err.message : t("labs.editError"),
      );
    },
  });

  async function openEdit(reading: LabResultDto) {
    setEditingId(reading.id);
    setEditValue(String(reading.value));
    setEditTakenAt(toDateTimeLocal(reading.takenAt));
    setEditNote("");
    setEditError(null);
    // Load the decrypted note (list rows withhold it).
    setEditLoading(true);
    try {
      const detail = await apiGet<LabResultDetailDto>(
        `/api/labs/${reading.id}`,
      );
      setEditNote(detail.note ?? "");
    } catch {
      /* leave note blank on a load miss */
    } finally {
      setEditLoading(false);
    }
  }

  function closeEdit() {
    if (updateMutation.isPending) return;
    setEditingId(null);
    setEditError(null);
  }

  function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    const numericValue = parseDecimal(editValue);
    if (numericValue === null) {
      setEditError(t("labs.form.requiredError"));
      return;
    }
    const takenDate = new Date(editTakenAt);
    if (Number.isNaN(takenDate.getTime())) {
      setEditError(t("labs.editTimestampError"));
      return;
    }
    updateMutation.mutate({
      id: editingId,
      value: numericValue,
      takenAt: takenDate.toISOString(),
      note: editNote.trim() ? editNote.trim() : null,
    });
  }

  const ordered = [...readings].sort(
    (a, b) => new Date(b.takenAt).getTime() - new Date(a.takenAt).getTime(),
  );

  return (
    <>
      <ul className="divide-border divide-y">
        {ordered.map((r) => (
          <li
            key={r.id}
            className="flex items-center justify-between gap-3 py-3"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-foreground font-semibold tabular-nums">
                  {formatLabValue(r.value)} {r.unit}
                </span>
                <ReferenceRangeBadge status={r.rangeStatus} />
              </div>
              <p className="text-muted-foreground text-xs">
                {formatDateShort(r.takenAt, true)}
                {r.hasNote ? ` · ${t("labs.hasNote")}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                className="size-9"
                onClick={() => void openEdit(r)}
                aria-label={t("labs.editReading")}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <DeleteButton
                onConfirm={() => deleteMutation.mutate(r.id)}
                title={t("labs.deleteConfirmTitle")}
                description={t("labs.deleteConfirmDescription")}
                confirmLabel={t("labs.deleteReading")}
                className="size-9"
                iconClassName="h-4 w-4"
              />
            </div>
          </li>
        ))}
      </ul>

      <ResponsiveSheet
        open={editingId !== null}
        onOpenChange={(open) => {
          if (!open) closeEdit();
        }}
        title={t("labs.editTitle")}
        description={t("labs.editDescription")}
      >
        <form onSubmit={submitEdit} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="lab-edit-value">{t("labs.form.value")}</Label>
              <Input
                id="lab-edit-value"
                inputMode="decimal"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lab-edit-takenAt">
                {t("labs.form.takenAt")}
              </Label>
              <DateTimeInput
                id="lab-edit-takenAt"
                value={editTakenAt}
                onChange={(e) => setEditTakenAt(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lab-edit-note">{t("labs.form.note")}</Label>
            <Textarea
              id="lab-edit-note"
              value={editNote}
              onChange={(e) => setEditNote(e.target.value)}
              maxLength={NOTE_MAX_LENGTH}
              rows={2}
              disabled={editLoading}
            />
          </div>
          {editError ? (
            <p className="text-destructive text-sm" role="alert">
              {editError}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={closeEdit}
              disabled={updateMutation.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : null}
              {t("common.save")}
            </Button>
          </div>
        </form>
      </ResponsiveSheet>
    </>
  );
}
