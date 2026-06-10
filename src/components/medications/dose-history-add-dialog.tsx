"use client";

/**
 * v1.15.18 WE — add-intake dialog scoped to one medication, reached from the
 * Verlauf tab header. A trimmed sibling of `<LogIntakeDialog>` (which spans
 * every active medication from the list page): this one is pre-bound to the
 * medication whose ledger the user is editing, so it drops the medication
 * picker and adds the late-take nudge.
 *
 * The nudge (Marc decision): when the picked `takenAt` falls JUST OUTSIDE a
 * slot's on-time window — close enough that it is plausibly that dose, but
 * past the ±1h default band — the dialog offers "diesem Slot zuordnen?". On
 * accept the write carries `forceSlotInstant` (the nearest slot's instant on
 * the chosen day), pinning the take onto that scheduled slot instead of
 * orphaning it to an ad-hoc row. The server validates the instant is a real
 * slot (422 otherwise, surfaced as a toast). Decline → the take records
 * ad-hoc (no `scheduledFor`); an exact slot match pins directly with no nudge.
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
import { Switch } from "@/components/ui/switch";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, medicationDependentKeys } from "@/lib/query-keys";
import type { QueryKey } from "@tanstack/react-query";
import type { LedgerSchedule } from "@/components/medications/dose-history-ledger";

export interface LedgerAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  medicationId: string;
  medicationName: string;
  schedules: LedgerSchedule[];
  /** The Verlauf tab's ledger key so the add invalidates it alongside the
   * shared medication bundle. */
  ledgerKey: QueryKey;
}

/** The default on-time half-window in minutes (±1h, `DOSE_WINDOW_DEFAULTS`). A
 * take within this of a slot is an exact match (no nudge); past it but inside
 * the nudge ceiling triggers "diesem Slot zuordnen?". */
const ON_TIME_MINUTES = 60;
/** Past this gap a take is clearly its own ad-hoc event — no nudge. */
const NUDGE_CEILING_MINUTES = 240;

/** `<input type="datetime-local">` shape for a Date in local time. */
function toDateTimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** Distinct HH:mm slot times across the medication's schedules. */
function slotTimes(schedules: LedgerSchedule[]): string[] {
  const times = new Set<string>();
  for (const s of schedules) {
    if (s.timesOfDay && s.timesOfDay.length > 0) {
      for (const tod of s.timesOfDay) times.add(tod);
    } else if (s.windowStart) {
      times.add(s.windowStart);
    }
  }
  return Array.from(times).sort((a, b) => a.localeCompare(b));
}

/** The slot instant on the take's local day for an "HH:mm" slot. */
function slotInstantOnDay(takenAtLocal: string, slotHm: string): Date | null {
  const datePart = takenAtLocal.slice(0, 10);
  if (datePart.length !== 10) return null;
  const d = new Date(`${datePart}T${slotHm}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface NearestSlot {
  slotHm: string;
  instant: Date;
  gapMinutes: number;
}

/** The nearest schedule slot to the picked `takenAt` on its own day, with the
 * absolute gap in minutes. `null` when the medication has no time-anchored
 * slots (PRN) or the input is unparseable. */
export function nearestSlotForTake(
  takenAtLocal: string,
  times: string[],
): NearestSlot | null {
  const taken = new Date(takenAtLocal);
  if (Number.isNaN(taken.getTime())) return null;
  let best: NearestSlot | null = null;
  for (const slotHm of times) {
    const instant = slotInstantOnDay(takenAtLocal, slotHm);
    if (!instant) continue;
    const gapMinutes = Math.abs(instant.getTime() - taken.getTime()) / 60_000;
    if (!best || gapMinutes < best.gapMinutes) {
      best = { slotHm, instant, gapMinutes };
    }
  }
  return best;
}

/** Classify the take against its nearest slot: an exact in-window match pins
 * directly; a near-miss prompts the nudge; anything else records ad-hoc. */
export function classifyTake(
  nearest: NearestSlot | null,
): "exact" | "nudge" | "ad_hoc" {
  if (!nearest) return "ad_hoc";
  if (nearest.gapMinutes <= ON_TIME_MINUTES) return "exact";
  if (nearest.gapMinutes <= NUDGE_CEILING_MINUTES) return "nudge";
  return "ad_hoc";
}

export function LedgerAddDialog({
  open,
  onOpenChange,
  medicationId,
  medicationName,
  schedules,
  ledgerKey,
}: LedgerAddDialogProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const [takenAt, setTakenAt] = useState(() => toDateTimeLocal(new Date()));
  const [skipped, setSkipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nudgeOpen, setNudgeOpen] = useState(false);

  const times = useMemo(() => slotTimes(schedules), [schedules]);
  const nearest = useMemo(
    () => (skipped ? null : nearestSlotForTake(takenAt, times)),
    [skipped, takenAt, times],
  );
  const classification = useMemo(() => classifyTake(nearest), [nearest]);

  /** Fire the write. `pin` true sends `forceSlotInstant` to bind the take onto
   * the nearest slot; false/exact uses `scheduledFor` for an in-window match,
   * else records ad-hoc. */
  async function write(pin: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { skipped };
      if (!skipped) body.takenAt = new Date(takenAt).toISOString();
      if (!skipped && nearest) {
        if (classification === "exact") {
          body.scheduledFor = nearest.instant.toISOString();
        } else if (pin) {
          body.forceSlotInstant = nearest.instant.toISOString();
        }
      }
      const res = await fetch(`/api/medications/${medicationId}/intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // A 422 here is the force-slot guard rejecting a non-slot instant;
        // surface it rather than silently dropping the dose.
        toast.error(
          t("medications.intakeToastFailed", { name: medicationName }),
        );
        return;
      }
      toast.success(
        t(
          skipped
            ? "medications.intakeToastSkipped"
            : "medications.intakeToastTaken",
          { name: medicationName },
        ),
      );
      await invalidateKeys(queryClient, [
        ...medicationDependentKeys,
        ledgerKey,
      ]);
      setNudgeOpen(false);
      onOpenChange(false);
    } catch {
      toast.error(t("medications.intakeToastFailed", { name: medicationName }));
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    // A near-miss take prompts the slot-attribution nudge before writing;
    // everything else writes straight through.
    if (!skipped && classification === "nudge") {
      setNudgeOpen(true);
      return;
    }
    void write(false);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent data-slot="ledger-add-dialog">
        <DialogHeader>
          <DialogTitle>
            {t("medications.detail.verlauf.addDialog.title")}
          </DialogTitle>
          <DialogDescription>
            {t("medications.detail.verlauf.addDialog.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="ledger-add-taken-at">
              {t("medications.detail.verlauf.addDialog.takenAtLabel")}
            </Label>
            <Input
              id="ledger-add-taken-at"
              type="datetime-local"
              value={takenAt}
              max={toDateTimeLocal(new Date())}
              onChange={(e) => setTakenAt(e.target.value)}
              disabled={skipped}
            />
          </div>

          <label
            htmlFor="ledger-add-skipped"
            className="flex items-center justify-between gap-3"
          >
            <span className="text-sm font-medium">
              {t("medications.detail.verlauf.addDialog.skippedLabel")}
            </span>
            <Switch
              id="ledger-add-skipped"
              checked={skipped}
              onCheckedChange={setSkipped}
            />
          </label>

          {/* A near-miss take previews where it will land before the user
              commits — calm, not alarming. */}
          {!skipped && classification === "nudge" && nearest && (
            <p
              className="text-muted-foreground text-xs"
              data-slot="ledger-add-nudge-hint"
            >
              {t("medications.detail.verlauf.addDialog.nudgeHint", {
                slot: nearest.slotHm,
              })}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t("medications.detail.verlauf.addDialog.cancel")}
          </Button>
          <Button
            onClick={submit}
            disabled={busy}
            aria-busy={busy || undefined}
            data-slot="ledger-add-submit"
          >
            {busy && (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            )}
            {t("medications.detail.verlauf.addDialog.submit")}
          </Button>
        </DialogFooter>

        {/* The "diesem Slot zuordnen?" nudge — pin onto the slot, or keep the
            take as a standalone ad-hoc entry. */}
        {nudgeOpen && nearest && (
          <Dialog
            open={nudgeOpen}
            onOpenChange={(o) => !busy && setNudgeOpen(o)}
          >
            <DialogContent data-slot="ledger-add-nudge-dialog">
              <DialogHeader>
                <DialogTitle>
                  {t("medications.detail.verlauf.nudge.title")}
                </DialogTitle>
                <DialogDescription>
                  {t("medications.detail.verlauf.nudge.body", {
                    slot: nearest.slotHm,
                  })}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => void write(false)}
                  disabled={busy}
                  data-slot="ledger-add-nudge-adhoc"
                >
                  {t("medications.detail.verlauf.nudge.keepAdHoc")}
                </Button>
                <Button
                  onClick={() => void write(true)}
                  disabled={busy}
                  aria-busy={busy || undefined}
                  data-slot="ledger-add-nudge-pin"
                >
                  {busy && (
                    <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                  )}
                  {t("medications.detail.verlauf.nudge.pin")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </DialogContent>
    </Dialog>
  );
}
