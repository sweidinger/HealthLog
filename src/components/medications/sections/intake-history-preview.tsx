"use client";

/**
 * v1.5.5 D-3 §9.5 — Intake-history preview.
 *
 * Section chrome via `<MedicationDetailSection>`. Header CTA carries
 * the only CSV-import trigger in the app (the v1.5.4 per-card kebab
 * went away). The body re-uses `<IntakeHistoryListV2>` so the v1.5.4
 * table + sort + pagination stay byte-identical; the preview adds a
 * footer link to the full `/medications/[id]/history` route.
 *
 * v1.5.5 F-1 C-2 add-ons (Features 15 + 16 from I-1):
 *   - Multi-select bulk-delete: the preview drives the
 *     `<IntakeHistoryListV2>` selection contract and renders a
 *     bulk-delete toolbar above the table when the user has at
 *     least one row selected. POSTs to the v1.5.5 bulk-delete
 *     endpoint then fires `medicationDependentKeys` so the inline
 *     compliance tile + rollup-tier dashboard chart converge in one
 *     tick.
 *   - Per-row kebab: Bearbeiten opens an inline `<IntakeEditDialog>`
 *     (PUT `/api/medications/{id}/intake/{eventId}`); Löschen fires
 *     a single-step `<AlertDialog>` and DELETEs the same row.
 */

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { IntakeEditDialog } from "@/components/medications/intake-edit-dialog";
import {
  IntakeHistoryListV2,
  type IntakeEvent,
} from "@/components/medications/intake-history-list-v2";
import { IntakeImportDialog } from "@/components/medications/intake-import-dialog";
import { MedicationDetailSection } from "@/components/medications/medication-detail-section";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, medicationDependentKeys } from "@/lib/query-keys";

export interface IntakeHistoryPreviewProps {
  medicationId: string;
  importOpen: boolean;
  onImportOpenChange: (open: boolean) => void;
}

export function IntakeHistoryPreview({
  medicationId,
  importOpen,
  onImportOpenChange,
}: IntakeHistoryPreviewProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingEvent, setEditingEvent] = useState<IntakeEvent | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [rowDeleteBusy, setRowDeleteBusy] = useState(false);

  function onToggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  async function confirmBulkDelete() {
    if (bulkBusy || selected.size === 0) return;
    setBulkBusy(true);
    const ids = Array.from(selected);
    try {
      const res = await fetch(
        `/api/medications/${medicationId}/intake/bulk-delete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventIds: ids }),
        },
      );
      if (!res.ok) {
        toast.error(t("medications.detail.intake.bulkDelete.failed"));
        return;
      }
      await invalidateKeys(queryClient, medicationDependentKeys);
      toast.success(t("medications.detail.intake.bulkDelete.toast"));
      setBulkConfirmOpen(false);
      clearSelection();
    } catch {
      toast.error(t("medications.detail.intake.bulkDelete.failed"));
    } finally {
      setBulkBusy(false);
    }
  }

  async function confirmRowDelete() {
    if (rowDeleteBusy || !pendingDeleteId) return;
    setRowDeleteBusy(true);
    const id = pendingDeleteId;
    try {
      const res = await fetch(
        `/api/medications/${medicationId}/intake/${id}`,
        {
          method: "DELETE",
        },
      );
      if (!res.ok) {
        toast.error(t("medications.detail.intake.deleteRow.failed"));
        return;
      }
      await invalidateKeys(queryClient, medicationDependentKeys);
      toast.success(t("medications.detail.intake.deleteRow.toast"));
      setPendingDeleteId(null);
      // Drop the deleted row from the pending selection so the
      // bulk-toolbar count stays honest.
      setSelected((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch {
      toast.error(t("medications.detail.intake.deleteRow.failed"));
    } finally {
      setRowDeleteBusy(false);
    }
  }

  return (
    <>
      <MedicationDetailSection
        titleId="medication-detail-intake-history-heading"
        title={t("medications.detail.intake.title")}
        dataSlot="medication-detail-intake-history-section"
        headerExtras={
          <Button
            variant="outline"
            size="sm"
            onClick={() => onImportOpenChange(true)}
            className="min-h-11 sm:min-h-9"
            data-slot="intake-history-import"
          >
            <Upload aria-hidden="true" className="h-4 w-4" />
            {t("medications.detail.intake.importButton")}
          </Button>
        }
      >
        <div className="space-y-3" data-slot="intake-history-preview-body">
          {selected.size > 0 && (
            <div
              className="border-border bg-muted/40 flex flex-wrap items-center justify-between gap-2 rounded-md border p-2"
              role="region"
              aria-label={t(
                "medications.detail.intake.bulkDelete.selectionCount",
                { count: selected.size },
              )}
              data-slot="intake-history-bulk-delete-toolbar"
            >
              <span className="text-foreground text-sm font-medium">
                {t("medications.detail.intake.bulkDelete.selectionCount", {
                  count: selected.size,
                })}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={clearSelection}
                  className="min-h-11 sm:min-h-9"
                  data-slot="intake-history-bulk-cancel"
                >
                  {t("medications.detail.intake.bulkDelete.cancelButton")}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setBulkConfirmOpen(true)}
                  className="min-h-11 sm:min-h-9"
                  data-slot="intake-history-bulk-delete"
                >
                  <Trash2 aria-hidden="true" className="h-4 w-4" />
                  {t("medications.detail.intake.bulkDelete.deleteButton")}
                </Button>
              </div>
            </div>
          )}

          <IntakeHistoryListV2
            medicationId={medicationId}
            pageSize={14}
            onEditIntake={setEditingEvent}
            onDeleteIntake={setPendingDeleteId}
            selection={{
              mode: "multi",
              selected,
              onToggle,
            }}
          />
          <p className="text-right text-xs">
            <Link
              href={`/medications/${medicationId}/history`}
              className="text-primary inline-flex min-h-11 items-center underline-offset-4 hover:underline sm:min-h-9"
              data-slot="intake-history-full-link"
            >
              {t("medications.detail.intake.viewAllLink")}
            </Link>
          </p>
        </div>
      </MedicationDetailSection>

      {importOpen && (
        <IntakeImportDialog
          medicationId={medicationId}
          onClose={() => onImportOpenChange(false)}
        />
      )}

      <IntakeEditDialog
        medicationId={medicationId}
        event={
          editingEvent
            ? {
                id: editingEvent.id,
                takenAt: editingEvent.takenAt,
                skipped: editingEvent.skipped,
              }
            : null
        }
        onClose={() => setEditingEvent(null)}
      />

      <AlertDialog
        open={bulkConfirmOpen}
        onOpenChange={(open) => {
          if (!open) setBulkConfirmOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("medications.detail.intake.bulkDelete.confirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("medications.detail.intake.bulkDelete.confirmBody", {
                count: selected.size,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkBusy}>
              {t("medications.detail.intake.bulkDelete.cancelButton")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmBulkDelete();
              }}
              disabled={bulkBusy}
              aria-busy={bulkBusy || undefined}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("medications.detail.intake.bulkDelete.confirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!pendingDeleteId}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("medications.detail.intake.deleteRow.confirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("medications.detail.intake.deleteRow.confirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rowDeleteBusy}>
              {t("medications.detail.intake.bulkDelete.cancelButton")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmRowDelete();
              }}
              disabled={rowDeleteBusy}
              aria-busy={rowDeleteBusy || undefined}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("medications.detail.intake.deleteRow.confirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
