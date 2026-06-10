"use client";

/**
 * v1.5.5 F-1 C-2 — per-row Bearbeiten dialog on the detail-page
 * intake-history preview.
 *
 * Restores the row-level edit affordance the v1.5.4 flat-form
 * retirement displaced (I-1 §15). The dialog opens from the
 * intake-history kebab; fields are `takenAt` (datetime-local) and
 * `skipped` (boolean). On save it PATCHes
 * `/api/medications/{id}/intake/{eventId}` and fires the
 * medication cache bundle so the inline compliance tile + dashboard
 * chart converge in the same tick.
 *
 * v1.15.19 (audit P0-4) — date-typo guardrails on the edit path:
 * the picker is capped at "now" (mirrors the add dialog), the row's
 * scheduled slot renders under the input so the user sees what they
 * are editing against, and a non-blocking hint appears when the
 * picked time sits more than 48h from that slot. The former free-text
 * note field is gone — the API schema stripped it and nothing ever
 * persisted it (audit LOW-10), so the dialog no longer pretends.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, medicationDependentKeys } from "@/lib/query-keys";

export interface IntakeEditDialogProps {
  medicationId: string;
  /** Event being edited; `null` closes the dialog. */
  event: {
    id: string;
    takenAt: string | null;
    skipped: boolean;
    /** The row's slot anchor, ISO — renders as the "Geplant" reference
     * and drives the far-from-slot hint. */
    scheduledFor?: string | null;
  } | null;
  onClose: () => void;
}

/** Past this gap between the picked time and the scheduled slot the
 * dialog surfaces the "check the date" hint — generous enough that a
 * genuinely late dose never nags, tight enough that a month-off typo
 * cannot pass silently. */
const FAR_FROM_SLOT_MS = 48 * 60 * 60 * 1000;

/**
 * Convert an ISO timestamp (or Date) into the `<input type="datetime-local">`
 * shape `YYYY-MM-DDTHH:mm`. Returns an empty string for null inputs.
 * The string is rendered in the user's local time so the picker
 * matches the dose timestamp the user remembers.
 */
function toDateTimeLocal(value: string | Date | null): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate(),
  )}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** True when the picked local datetime sits more than 48h from the
 * row's scheduled slot. Unparseable or absent values never warn. */
export function isFarFromSlot(
  takenAtLocal: string,
  scheduledFor: string | null | undefined,
): boolean {
  if (!takenAtLocal || !scheduledFor) return false;
  const taken = new Date(takenAtLocal);
  const slot = new Date(scheduledFor);
  if (Number.isNaN(taken.getTime()) || Number.isNaN(slot.getTime()))
    return false;
  return Math.abs(taken.getTime() - slot.getTime()) > FAR_FROM_SLOT_MS;
}

export function IntakeEditDialog(props: IntakeEditDialogProps) {
  // Re-mount the body whenever the event id flips so the form state
  // initialises from the row the user clicked. The wrapper is also
  // responsible for not rendering the dialog when `event` is null.
  if (!props.event) return null;
  return <IntakeEditDialogBody key={props.event.id} {...props} />;
}

function IntakeEditDialogBody({
  medicationId,
  event,
  onClose,
}: IntakeEditDialogProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();
  const [takenAt, setTakenAt] = useState(() =>
    toDateTimeLocal(event?.takenAt ?? null),
  );
  const [skipped, setSkipped] = useState(() => event?.skipped ?? false);
  const [busy, setBusy] = useState(false);

  if (!event) return null;

  const scheduledFor = event.scheduledFor ?? null;
  const showFarHint = !skipped && isFarFromSlot(takenAt, scheduledFor);

  async function save() {
    if (!event || busy) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        skipped,
      };
      if (takenAt) {
        // Re-attach the local-time string to ISO with the user's
        // current tz offset so the server stores the canonical UTC
        // value the picker showed.
        body.takenAt = new Date(takenAt).toISOString();
      } else {
        body.takenAt = null;
      }
      const res = await fetch(
        `/api/medications/${medicationId}/intake/${event.id}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        toast.error(t("medications.detail.intake.edit.failed"));
        return;
      }
      await invalidateKeys(queryClient, medicationDependentKeys);
      toast.success(t("medications.detail.intake.edit.savedToast"));
      onClose();
    } catch {
      toast.error(t("medications.detail.intake.edit.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!event} onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-slot="intake-edit-dialog">
        <DialogHeader>
          <DialogTitle>
            {t("medications.detail.intake.edit.dialogTitle")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="intake-edit-taken-at">
              {t("medications.detail.intake.edit.takenAtLabel")}
            </Label>
            <Input
              id="intake-edit-taken-at"
              type="datetime-local"
              value={takenAt}
              max={toDateTimeLocal(new Date())}
              onChange={(e) => setTakenAt(e.target.value)}
              disabled={skipped}
            />
            {scheduledFor && (
              <p
                className="text-muted-foreground text-xs"
                data-slot="intake-edit-scheduled-hint"
              >
                {t("medications.detail.intake.edit.scheduledForHint", {
                  dateTime: fmt.dateTime(scheduledFor),
                })}
              </p>
            )}
            {/* Non-blocking: a 48h+ gap to the slot is almost always a
                date typo, but a deliberate far edit stays saveable. */}
            {showFarHint && (
              <p
                className="text-xs text-amber-600 dark:text-amber-400"
                data-slot="intake-edit-far-hint"
              >
                {t("medications.detail.intake.edit.farFromScheduledWarning")}
              </p>
            )}
          </div>
          <label
            htmlFor="intake-edit-skipped"
            className="flex items-center justify-between gap-3"
          >
            <span className="text-sm font-medium">
              {t("medications.detail.intake.edit.skippedLabel")}
            </span>
            <Switch
              id="intake-edit-skipped"
              checked={skipped}
              onCheckedChange={(checked) => setSkipped(checked)}
            />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("medications.detail.intake.edit.cancel")}
          </Button>
          <Button
            onClick={() => void save()}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {busy && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
            )}
            {t("medications.detail.intake.edit.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
