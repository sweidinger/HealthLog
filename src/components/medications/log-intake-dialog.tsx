"use client";

/**
 * v1.14.0 — manual intake logger reachable from the medications-page
 * "Add" choice. The top-of-page Add button now offers two paths: create a
 * new medication (the existing wizard) or LOG AN INTAKE against an existing
 * medication — including a backdated one.
 *
 * The form picks a medication, optionally pins a schedule slot, and a
 * date+time that defaults to "now" but accepts any past instant. It submits
 * to the existing `POST /api/medications/{id}/intake` route: `takenAt`
 * carries the (possibly backdated) instant, and a chosen slot supplies
 * `scheduledFor` so the write routes through the server's canonical slot
 * upsert — the same snap/upsert path a normal "Taken" tap uses — keeping
 * the one-row-per-dose-slot invariant intact. No new endpoint is minted.
 *
 * The submit orchestration lives in the pure, injection-tested
 * `runLogIntake` (see `use-medication-intake.ts`); this component owns only
 * the form state + the medication/slot pickers.
 */

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { useTranslations } from "@/lib/i18n/context";
import { runLogIntake } from "@/components/medications/use-medication-intake";

interface LogIntakeSchedule {
  windowStart: string;
  label: string | null;
  dose: string | null;
  timesOfDay?: string[];
}

export interface LogIntakeMedication {
  id: string;
  name: string;
  dose: string;
  schedules: LogIntakeSchedule[];
}

export interface LogIntakeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Active medications the user can log against. */
  medications: LogIntakeMedication[];
}

/** Sentinel option value meaning "no specific schedule slot" (PRN). */
const NO_SLOT = "__none__";

/**
 * `<input type="datetime-local">` shape `YYYY-MM-DDTHH:mm` for the given
 * Date rendered in the user's local time. Mirrors the intake-edit dialog so
 * both date pickers read the same way.
 */
function toDateTimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/**
 * Distinct HH:mm slot times for a medication, derived from each schedule's
 * first-class `timesOfDay` (falling back to `windowStart`). Sorted so the
 * morning slot leads. Empty for a medication with no time-anchored slots
 * (the PRN-only case), which simply hides the slot picker.
 */
function slotTimesFor(med: LogIntakeMedication | undefined): string[] {
  if (!med) return [];
  const times = new Set<string>();
  for (const s of med.schedules) {
    const fromTimes = s.timesOfDay && s.timesOfDay.length > 0;
    if (fromTimes) {
      for (const tod of s.timesOfDay!) times.add(tod);
    } else if (s.windowStart) {
      times.add(s.windowStart);
    }
  }
  return Array.from(times).sort((a, b) => a.localeCompare(b));
}

/**
 * Combine a `YYYY-MM-DD` date part (read off the picked `takenAt`) with an
 * `HH:mm` slot time into an ISO instant in the user's local timezone. This
 * is the slot instant on the chosen day; the server snaps it to the
 * canonical slot via the same upsert a live "Taken" tap uses.
 */
function slotInstantIso(takenAtLocal: string, slotHm: string): string | null {
  const datePart = takenAtLocal.slice(0, 10);
  if (datePart.length !== 10) return null;
  const d = new Date(`${datePart}T${slotHm}`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function LogIntakeDialog({
  open,
  onOpenChange,
  medications,
}: LogIntakeDialogProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const [medicationId, setMedicationId] = useState<string>(
    () => medications[0]?.id ?? "",
  );
  const [slot, setSlot] = useState<string>(NO_SLOT);
  const [takenAt, setTakenAt] = useState<string>(() =>
    toDateTimeLocal(new Date()),
  );
  const [skipped, setSkipped] = useState(false);
  const [busy, setBusy] = useState(false);

  const selected = useMemo(
    () => medications.find((m) => m.id === medicationId),
    [medications, medicationId],
  );
  const slotTimes = useMemo(() => slotTimesFor(selected), [selected]);

  function handleMedicationChange(id: string) {
    setMedicationId(id);
    // Reset the slot when switching medications — the prior slot may not
    // exist on the new schedule.
    setSlot(NO_SLOT);
  }

  async function submit() {
    if (!medicationId || busy) return;
    const med = medications.find((m) => m.id === medicationId);
    if (!med) return;
    // A pinned slot must resolve to a real instant; if it can't, surface an
    // error rather than silently logging the dose through the unscheduled path
    // (which would miss the canonical slot upsert and could duplicate the row).
    let scheduledFor: string | undefined;
    if (slot !== NO_SLOT) {
      const iso = slotInstantIso(takenAt, slot);
      if (!iso) {
        toast.error(t("medications.logIntake.slotError"));
        return;
      }
      scheduledFor = iso;
    }
    setBusy(true);
    try {
      const ok = await runLogIntake({
        medication: { id: med.id, name: med.name },
        skipped,
        takenAt: new Date(takenAt).toISOString(),
        scheduledFor,
        t,
        queryClient,
      });
      if (ok) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent data-slot="log-intake-dialog">
        <DialogHeader>
          <DialogTitle>{t("medications.logIntake.dialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("medications.logIntake.dialogDescription")}
          </DialogDescription>
        </DialogHeader>

        {medications.length === 0 ? (
          <p className="text-muted-foreground py-4 text-sm">
            {t("medications.logIntake.noMedications")}
          </p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="log-intake-medication">
                {t("medications.logIntake.medicationLabel")}
              </Label>
              <NativeSelect
                id="log-intake-medication"
                value={medicationId}
                onChange={(e) => handleMedicationChange(e.target.value)}
              >
                {medications.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.dose ? `${m.name} — ${m.dose}` : m.name}
                  </option>
                ))}
              </NativeSelect>
            </div>

            {slotTimes.length > 0 && (
              <div className="space-y-1">
                <Label htmlFor="log-intake-slot">
                  {t("medications.logIntake.slotLabel")}
                </Label>
                <NativeSelect
                  id="log-intake-slot"
                  value={slot}
                  onChange={(e) => setSlot(e.target.value)}
                >
                  <option value={NO_SLOT}>
                    {t("medications.logIntake.slotNone")}
                  </option>
                  {slotTimes.map((time) => (
                    <option key={time} value={time}>
                      {time}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}

            <div className="space-y-1">
              <Label htmlFor="log-intake-taken-at">
                {t("medications.logIntake.takenAtLabel")}
              </Label>
              <Input
                id="log-intake-taken-at"
                type="datetime-local"
                value={takenAt}
                max={toDateTimeLocal(new Date())}
                onChange={(e) => setTakenAt(e.target.value)}
                disabled={skipped}
              />
              <p className="text-muted-foreground text-xs">
                {t("medications.logIntake.takenAtHint")}
              </p>
            </div>

            <label
              htmlFor="log-intake-skipped"
              className="flex items-center justify-between gap-3"
            >
              <span className="text-sm font-medium">
                {t("medications.logIntake.skippedLabel")}
              </span>
              <Switch
                id="log-intake-skipped"
                checked={skipped}
                onCheckedChange={setSkipped}
              />
            </label>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t("medications.logIntake.cancel")}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy || medications.length === 0 || !medicationId}
            aria-busy={busy || undefined}
          >
            {busy && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
            )}
            {t("medications.logIntake.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
