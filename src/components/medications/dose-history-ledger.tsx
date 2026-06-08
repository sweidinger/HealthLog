"use client";

/**
 * v1.15.18 WE — the Verlauf tab's dose-history ledger.
 *
 * Renders the server-minted ledger (`GET /api/medications/[id]/dose-history`):
 * EVERY expected slot with its status (pünktlich / verspätet / übersprungen /
 * verpasst / ausstehend) even when never taken, plus every off-schedule intake
 * as a tagged ad-hoc row at its real time. Rows are grouped by day, most-recent
 * day first, chronological inside the day.
 *
 * Three interactions land here:
 *   - a pending / missed slot exposes Genommen / Übersprungen ON the row
 *     (~2 taps, not buried), which mark the dose with INSTANT feedback — the
 *     cached ledger + the headline % are mutated optimistically (the engines
 *     are pure, so the client mirrors their accounting) before the server
 *     write fires and the authoritative refetch reconciles;
 *   - any row with an intake can be edited (time / skipped) or deleted via the
 *     shared `<IntakeEditDialog>` + delete confirm;
 *   - a header "+ Eintrag" opens an add dialog scoped to this medication
 *     (incl. backdated / off-schedule); an off-window take surfaces the
 *     "diesem Slot zuordnen?" nudge, pinning it onto a chosen slot via
 *     `forceSlotInstant` rather than orphaning it to an ad-hoc row.
 *
 * A compact took / skipped history chart sits at the top — the ledger already
 * carries the counts. The card body never tints by status (removed earlier);
 * the ledger uses the semantic feedback vocabulary on the row, not the card.
 */

import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CircleCheck,
  Loader2,
  Plus,
  SkipForward,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { useAuth } from "@/hooks/use-auth";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import {
  invalidateKeys,
  medicationDependentKeys,
  queryKeys,
} from "@/lib/query-keys";
import type { DoseHistoryStatus } from "@/lib/medications/scheduling/dose-history";
import { IntakeEditDialog } from "@/components/medications/intake-edit-dialog";
import { LedgerAddDialog } from "@/components/medications/dose-history-add-dialog";
import {
  applyOptimisticSlotMark,
  complianceFromLedger,
  groupLedgerByDay,
  isSlotActionable,
  type LedgerPayload,
  type LedgerRow,
} from "@/components/medications/dose-history-ledger-compute";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A schedule slot the add dialog offers for pinning. */
export interface LedgerSchedule {
  windowStart: string;
  label: string | null;
  dose: string | null;
  timesOfDay?: string[];
}

export interface DoseHistoryLedgerProps {
  medicationId: string;
  medicationName: string;
  schedules: LedgerSchedule[];
  /** Trailing window in days the ledger renders. Defaults to 90. */
  windowDays?: number;
}

/** Status → semantic colour token + glyph. Mirrors the card status pill's
 * success / warning / destructive ramp so the surface reads as one vocabulary;
 * skipped + upcoming are calm muted, ad-hoc is the neutral-positive accent. */
const STATUS_TONE: Record<DoseHistoryStatus, string> = {
  taken_on_time: "text-success",
  taken_late: "text-warning",
  skipped: "text-muted-foreground",
  missed: "text-destructive",
  upcoming: "text-muted-foreground",
  ad_hoc: "text-primary",
};

function StatusGlyph({ status }: { status: DoseHistoryStatus }) {
  const cls = "size-3.5 shrink-0";
  switch (status) {
    case "taken_on_time":
      return <CircleCheck aria-hidden="true" className={cls} />;
    case "taken_late":
      return <AlertCircle aria-hidden="true" className={cls} />;
    case "missed":
      return <AlertTriangle aria-hidden="true" className={cls} />;
    case "ad_hoc":
      return <Plus aria-hidden="true" className={cls} />;
    case "skipped":
      return <SkipForward aria-hidden="true" className={cls} />;
    default:
      return null;
  }
}

export function DoseHistoryLedger({
  medicationId,
  medicationName,
  schedules,
  windowDays = 90,
}: DoseHistoryLedgerProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const timeZone = user?.timezone || "Europe/Berlin";

  const [addOpen, setAddOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<{
    id: string;
    takenAt: string | null;
    skipped: boolean;
  } | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [marking, setMarking] = useState<string | null>(null);

  // Stable window captured once at mount (a lazy state initializer keeps the
  // impure `Date.now()` out of render) so the query key + the `from`/`to`
  // request stay byte-equal across renders rather than re-keying every paint.
  const [{ fromIso, toIso }] = useState(() => {
    const now = Date.now();
    return {
      toIso: new Date(now).toISOString(),
      fromIso: new Date(now - windowDays * DAY_MS).toISOString(),
    };
  });

  const queryKey = queryKeys.medicationDoseHistory(medicationId, fromIso, toIso);

  const { data, isLoading, isError } = useQuery<LedgerPayload>({
    queryKey,
    queryFn: async () => {
      const search = new URLSearchParams({ from: fromIso, to: toIso });
      const res = await fetch(
        `/api/medications/${medicationId}/dose-history?${search.toString()}`,
      );
      if (!res.ok) throw new Error("dose_history_failed");
      return (await res.json()).data as LedgerPayload;
    },
    staleTime: 15_000,
  });

  const compliance = useMemo(
    () => (data ? complianceFromLedger(data.rows) : null),
    [data],
  );

  const groups = useMemo(
    () => (data ? groupLedgerByDay(data.rows, timeZone) : []),
    [data, timeZone],
  );

  /**
   * Genommen / Übersprungen on a pending / missed slot. The cached ledger is
   * mutated optimistically (row status + the headline % flip in this paint),
   * then the server write fires and the dependent-key invalidation reconciles.
   * A failed write rolls the optimistic snapshot back + toasts (mirrors the
   * C1/C2 pattern in `use-medication-intake.ts`).
   */
  const markSlot = useCallback(
    async (row: LedgerRow, action: "taken" | "skipped") => {
      if (marking || !isSlotActionable(row)) return;
      setMarking(`${row.at}:${action}`);

      const prev = queryClient.getQueryData<LedgerPayload>(queryKey);
      if (prev) {
        queryClient.setQueryData<LedgerPayload>(
          queryKey,
          applyOptimisticSlotMark(prev, row.at, action),
        );
      }

      try {
        const res = await fetch(`/api/medications/${medicationId}/intake`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Pin the displayed slot so the server marks THAT dose (the canonical
          // slot upsert), not a now-snap to the nearest one.
          body: JSON.stringify(
            action === "skipped"
              ? { skipped: true, scheduledFor: row.at }
              : {
                  skipped: false,
                  scheduledFor: row.at,
                  takenAt: new Date().toISOString(),
                },
          ),
        });
        if (!res.ok) {
          if (prev) queryClient.setQueryData(queryKey, prev);
          toast.error(
            t("medications.intakeToastFailed", { name: medicationName }),
          );
          return;
        }
        toast.success(
          t(
            action === "skipped"
              ? "medications.intakeToastSkipped"
              : "medications.intakeToastTaken",
            { name: medicationName },
          ),
        );
        await invalidateKeys(queryClient, [
          ...medicationDependentKeys,
          queryKey,
        ]);
      } catch {
        if (prev) queryClient.setQueryData(queryKey, prev);
        toast.error(
          t("medications.intakeToastFailed", { name: medicationName }),
        );
      } finally {
        setMarking(null);
      }
    },
    [marking, medicationId, medicationName, queryClient, queryKey, t],
  );

  async function confirmRowDelete() {
    if (!pendingDeleteId) return;
    const id = pendingDeleteId;
    setPendingDeleteId(null);
    try {
      const res = await fetch(
        `/api/medications/${medicationId}/intake/${id}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        toast.error(t("medications.detail.intake.deleteRow.failed"));
        return;
      }
      toast.success(t("medications.detail.intake.deleteRow.toast"));
      await invalidateKeys(queryClient, [...medicationDependentKeys, queryKey]);
    } catch {
      toast.error(t("medications.detail.intake.deleteRow.failed"));
    }
  }

  return (
    <div className="space-y-4" data-slot="dose-history-ledger">
      {/* Header: the took/skipped summary chart + the add affordance. */}
      <div className="flex items-start justify-between gap-3">
        {compliance && compliance.denominator > 0 ? (
          <LedgerSummaryChart compliance={compliance} />
        ) : (
          <p className="text-muted-foreground text-sm">
            {t("medications.detail.verlauf.summaryEmpty")}
          </p>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAddOpen(true)}
          className="min-h-11 shrink-0 sm:min-h-9"
          data-slot="ledger-add"
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          {t("medications.detail.verlauf.add")}
        </Button>
      </div>

      {isLoading && (
        <div
          className="text-muted-foreground flex items-center gap-2 py-6 text-sm"
          role="status"
          aria-busy="true"
        >
          <Loader2
            aria-hidden="true"
            className="size-4 animate-spin motion-reduce:animate-none"
          />
          {t("medications.detail.verlauf.loading")}
        </div>
      )}

      {isError && (
        <p className="text-destructive py-6 text-sm">
          {t("medications.detail.verlauf.loadError")}
        </p>
      )}

      {data && !isLoading && groups.length === 0 && (
        <p className="text-muted-foreground py-6 text-sm">
          {t("medications.detail.verlauf.empty")}
        </p>
      )}

      {data &&
        groups.map((group) => (
          <section
            key={group.dayKey}
            className="space-y-1"
            data-slot="ledger-day"
            data-day={group.dayKey}
          >
            <h3 className="text-muted-foreground px-1 text-xs font-medium">
              {fmt.dateWithWeekday(new Date(`${group.dayKey}T00:00:00`))}
            </h3>
            <ul className="border-border/60 divide-border/60 divide-y rounded-md border">
              {group.rows.map((row, i) => (
                <LedgerRowItem
                  key={`${row.kind}:${row.at}:${row.intake?.id ?? i}`}
                  row={row}
                  marking={marking}
                  onMark={markSlot}
                  onEdit={(ev) => setEditingEvent(ev)}
                  onDelete={(id) => setPendingDeleteId(id)}
                />
              ))}
            </ul>
          </section>
        ))}

      <IntakeEditDialog
        medicationId={medicationId}
        event={editingEvent}
        onClose={() => setEditingEvent(null)}
      />

      {addOpen && (
        <LedgerAddDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          medicationId={medicationId}
          medicationName={medicationName}
          schedules={schedules}
          ledgerKey={queryKey}
        />
      )}

      {pendingDeleteId && (
        <DeleteRowConfirm
          onConfirm={() => void confirmRowDelete()}
          onCancel={() => setPendingDeleteId(null)}
        />
      )}
    </div>
  );
}

/**
 * One ledger row: time + status pill + (when an intake is attributed) its real
 * take time, plus the inline actions. A pending/missed slot offers Genommen /
 * Übersprungen; a row with an intake offers Bearbeiten / Löschen.
 */
function LedgerRowItem({
  row,
  marking,
  onMark,
  onEdit,
  onDelete,
}: {
  row: LedgerRow;
  marking: string | null;
  onMark: (row: LedgerRow, action: "taken" | "skipped") => void;
  onEdit: (event: {
    id: string;
    takenAt: string | null;
    skipped: boolean;
  }) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const actionable = isSlotActionable(row);
  const intake = row.intake;
  const takeBusy = marking === `${row.at}:taken`;
  const skipBusy = marking === `${row.at}:skipped`;

  // The leading time label: the slot's HH:mm for a slot row, else the ad-hoc
  // take's real clock time.
  const timeLabel =
    row.timeOfDay ?? fmt.time(new Date(intake?.takenAt ?? row.at));

  // When a take lands away from its slot, show both anchors so the row reads
  // "geplant 07:00 · genommen 11:29".
  const showTakeDetail =
    row.kind === "slot" &&
    intake?.takenAt &&
    (row.status === "taken_on_time" || row.status === "taken_late");

  return (
    <li
      className="flex items-center justify-between gap-2 px-3 py-2"
      data-slot="ledger-row"
      data-status={row.status}
      data-kind={row.kind}
    >
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-foreground text-sm font-medium tabular-nums">
            {timeLabel}
          </span>
          <span
            className={`inline-flex items-center gap-1 text-xs font-medium ${STATUS_TONE[row.status]}`}
            data-slot="ledger-status"
          >
            <StatusGlyph status={row.status} />
            {t(`medications.detail.verlauf.status.${row.status}`)}
          </span>
          {row.kind === "ad_hoc" && (
            <Badge variant="outline" className="text-[0.65rem]">
              {t("medications.detail.verlauf.adHocTag")}
            </Badge>
          )}
        </div>
        {showTakeDetail && (
          <p className="text-muted-foreground text-xs">
            {t("medications.detail.verlauf.takenDetail", {
              planned: row.timeOfDay ?? fmt.time(new Date(row.at)),
              taken: fmt.time(new Date(intake!.takenAt!)),
            })}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {actionable && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onMark(row, "taken")}
              disabled={takeBusy || skipBusy}
              aria-busy={takeBusy || undefined}
              className="min-h-9"
              data-slot="ledger-mark-taken"
            >
              {takeBusy ? (
                <Loader2
                  aria-hidden="true"
                  className="size-4 animate-spin motion-reduce:animate-none"
                />
              ) : (
                <Check aria-hidden="true" className="size-4" />
              )}
              <span className="hidden sm:inline">
                {t("medications.detail.verlauf.markTaken")}
              </span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onMark(row, "skipped")}
              disabled={takeBusy || skipBusy}
              aria-busy={skipBusy || undefined}
              className="min-h-9"
              data-slot="ledger-mark-skipped"
            >
              {skipBusy ? (
                <Loader2
                  aria-hidden="true"
                  className="size-4 animate-spin motion-reduce:animate-none"
                />
              ) : (
                <SkipForward aria-hidden="true" className="size-4" />
              )}
              <span className="hidden sm:inline">
                {t("medications.detail.verlauf.markSkipped")}
              </span>
            </Button>
          </>
        )}
        {intake?.id && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                onEdit({
                  id: intake.id as string,
                  takenAt: intake.takenAt,
                  skipped: intake.skipped,
                })
              }
              className="min-h-9"
              data-slot="ledger-edit"
            >
              {t("medications.detail.intake.rowActions.edit")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onDelete(intake.id as string)}
              className="text-destructive min-h-9"
              data-slot="ledger-delete"
            >
              {t("medications.detail.intake.rowActions.delete")}
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

/**
 * Compact took / skipped history chart — a single proportional bar split into
 * on-time / late / missed, with the headline rate beside it. No Recharts: a
 * three-segment CSS bar is calmer + lighter for a summary this small, and it
 * tracks the ledger the user is already reading.
 */
function LedgerSummaryChart({
  compliance,
}: {
  compliance: NonNullable<ReturnType<typeof complianceFromLedger>>;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { takenOnTime, takenLate, missed, denominator, rate } = compliance;
  const pct = (n: number) => (denominator > 0 ? (n / denominator) * 100 : 0);

  return (
    <div className="min-w-0 flex-1 space-y-1.5" data-slot="ledger-summary">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground text-xs font-medium">
          {t("medications.detail.verlauf.adherenceLabel")}
        </span>
        <span className="text-foreground text-sm font-semibold tabular-nums">
          {rate !== null ? `${fmt.number(rate)}%` : "—"}
        </span>
      </div>
      <div
        className="bg-muted flex h-2 overflow-hidden rounded-full"
        role="img"
        aria-label={t("medications.detail.verlauf.adherenceBarLabel", {
          onTime: takenOnTime,
          late: takenLate,
          missed,
        })}
      >
        <div
          className="bg-success h-full"
          style={{ width: `${pct(takenOnTime)}%` }}
        />
        <div
          className="bg-warning h-full"
          style={{ width: `${pct(takenLate)}%` }}
        />
        <div
          className="bg-destructive h-full"
          style={{ width: `${pct(missed)}%` }}
        />
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 text-[0.7rem]">
        <span className="text-success">
          {t("medications.detail.verlauf.status.taken_on_time")}: {takenOnTime}
        </span>
        <span className="text-warning">
          {t("medications.detail.verlauf.status.taken_late")}: {takenLate}
        </span>
        <span className="text-destructive">
          {t("medications.detail.verlauf.status.missed")}: {missed}
        </span>
      </div>
    </div>
  );
}

/** Lightweight single-row delete confirm — the ledger does not need the full
 * bulk-delete state machine, just a guard. */
function DeleteRowConfirm({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslations();
  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
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
          <AlertDialogCancel>
            {t("medications.detail.intake.bulkDelete.cancelButton")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {t("medications.detail.intake.deleteRow.confirmAction")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
