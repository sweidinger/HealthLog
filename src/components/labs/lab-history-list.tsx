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
import {
  ApiError,
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
} from "@/lib/api/api-fetch";
import { formatDateShort } from "@/lib/format";
import { formatLabReading } from "@/lib/labs/format-value";
import { resolveNoteForUpdate } from "@/lib/labs/note-update";
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
 * full edit + delete (L5). Edit opens a sheet that loads the decrypted note
 * from the single-resource GET; delete soft-deletes with an Undo toast that
 * restores via `/api/labs/restore` (the measurement pattern). An edit
 * overwrites in place — there is no append-only amendment trail.
 */
export function LabHistoryList({ readings }: { readings: LabResultDto[] }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  // v1.18.9 — true when the row being edited is a qualitative reading; the
  // editor then shows a text field and the PUT carries `valueText`.
  const [editIsQualitative, setEditIsQualitative] = useState(false);
  const [editValueText, setEditValueText] = useState("");
  const [editTakenAt, setEditTakenAt] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  // True when the decrypted-note GET failed to load for the row being edited.
  // We must NOT send `note: null` in that case — an empty editor then would
  // wipe a note we simply couldn't read. Instead the PUT omits `note` so the
  // server preserves the stored ciphertext untouched.
  const [noteLoadFailed, setNoteLoadFailed] = useState(false);
  const [hasNote, setHasNote] = useState(false);

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
      // Exactly one of value / valueText is set, matching the row's type.
      value: number | null;
      valueText: string | null;
      takenAt: string;
      // `undefined` → omit `note` from the PUT (leave the stored note
      // untouched); `null` → clear it; a string → set it.
      note: string | null | undefined;
    }) =>
      apiPut<LabResultDto>(`/api/labs/${body.id}`, {
        ...(body.value !== null ? { value: body.value } : {}),
        ...(body.valueText !== null ? { valueText: body.valueText } : {}),
        takenAt: body.takenAt,
        ...(body.note === undefined ? {} : { note: body.note }),
      }),
    onSuccess: () => {
      invalidate();
      toast.success(t("labs.editedToast"));
      closeEdit();
    },
    onError: (err) => {
      setEditError(err instanceof ApiError ? err.message : t("labs.editError"));
    },
  });

  async function openEdit(reading: LabResultDto) {
    setEditingId(reading.id);
    const qualitative = reading.value === null;
    setEditIsQualitative(qualitative);
    setEditValue(reading.value !== null ? String(reading.value) : "");
    setEditValueText(reading.valueText ?? "");
    setEditTakenAt(toDateTimeLocal(reading.takenAt));
    setEditNote("");
    setEditError(null);
    setNoteLoadFailed(false);
    setHasNote(reading.hasNote);
    // Load the decrypted note (list rows withhold it).
    setEditLoading(true);
    try {
      const detail = await apiGet<LabResultDetailDto>(
        `/api/labs/${reading.id}`,
      );
      setEditNote(detail.note ?? "");
    } catch {
      // The note couldn't be loaded. Flag it so the submit path omits `note`
      // (preserving the stored ciphertext) rather than sending `null` and
      // wiping a note we just failed to read.
      setNoteLoadFailed(true);
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
    let numericValue: number | null = null;
    let qualitativeValue: string | null = null;
    if (editIsQualitative) {
      const trimmed = editValueText.trim();
      if (trimmed === "") {
        setEditError(t("labs.form.requiredError"));
        return;
      }
      qualitativeValue = trimmed;
    } else {
      numericValue = parseDecimal(editValue);
      if (numericValue === null) {
        setEditError(t("labs.form.requiredError"));
        return;
      }
    }
    const takenDate = new Date(editTakenAt);
    if (Number.isNaN(takenDate.getTime())) {
      setEditError(t("labs.editTimestampError"));
      return;
    }
    updateMutation.mutate({
      id: editingId,
      value: numericValue,
      valueText: qualitativeValue,
      takenAt: takenDate.toISOString(),
      // `undefined` → omit `note` (server preserves the stored note when its
      // decrypted load failed); `null` → clear; text → set.
      note: resolveNoteForUpdate({
        noteLoadFailed,
        hadNote: hasNote,
        editorValue: editNote,
      }),
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
                  {formatLabReading(r)}
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
                // v1.18.10 (W10) — 44px touch target on mobile (WCAG 2.5.5),
                // compact 36px on desktop. The primary edit control for a row.
                className="size-11 sm:size-9"
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
                className="size-11 sm:size-9"
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
              <Label htmlFor="lab-edit-value">
                {editIsQualitative
                  ? t("labs.form.qualitativeResult")
                  : t("labs.form.value")}
              </Label>
              {editIsQualitative ? (
                <Input
                  id="lab-edit-value"
                  value={editValueText}
                  onChange={(e) => setEditValueText(e.target.value)}
                  maxLength={120}
                  required
                />
              ) : (
                <Input
                  id="lab-edit-value"
                  inputMode="decimal"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  required
                />
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lab-edit-takenAt">{t("labs.form.takenAt")}</Label>
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
              disabled={editLoading || (noteLoadFailed && hasNote)}
            />
            {noteLoadFailed && hasNote ? (
              <p className="text-muted-foreground text-xs">
                {t("labs.noteLoadFailed")}
              </p>
            ) : null}
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
