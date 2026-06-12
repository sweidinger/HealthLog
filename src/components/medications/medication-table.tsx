"use client";

import { useEffect, useReducer, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronsUpDown,
  Loader2,
  SkipForward,
} from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { MedicationStatusPill } from "@/components/medications/card-parts/medication-status-pill";
import { useWeekdayLabel } from "@/components/medications/card-parts/medication-next-last-slot";
import { resolveDisplayedSlotInstant } from "@/components/medications/card-parts/displayed-slot-instant";
import { useMedicationIntake } from "@/components/medications/use-medication-intake";
import {
  reduceCurrentWindowStatus,
  toZonedDate,
} from "@/lib/medications/window-status";
import { formatTime } from "@/lib/format";
import { formatTimeWindowRange } from "@/lib/time-window-format";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import {
  useMedicationComplianceSummary,
  useMedicationComplianceSummaryAll,
} from "@/lib/queries/use-medication-compliance-summary";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

/**
 * v1.16.10 — the compact table view for /medications (issue #316 item 3).
 *
 * One row per medication, the same data sources as the cards by
 * construction: the rows render straight off the `GET /api/medications`
 * list payload (next-due, stock), the Therapietreue column reads the
 * SAME batched compliance summary the cards share
 * (`useMedicationComplianceSummary`), the status cell mirrors the card
 * body's precedence over the SAME `reduceCurrentWindowStatus` /
 * server-`nextDueAt` gate, and the action buttons fire the SAME
 * `useMedicationIntake` mutation hook with the same displayed-slot
 * instant. Nothing here recomputes dueness beyond what the cards do.
 *
 * Responsive: horizontal scroll (the shared `<Table>` wrapper) with a
 * sticky first column so the medication name stays anchored while the
 * row scrolls. Action buttons keep the 44-px tap-target floor.
 */

interface TableSchedule {
  id: string;
  windowStart: string;
  windowEnd: string;
  label: string | null;
  dose: string | null;
  daysOfWeek: string | null;
  timesOfDay?: string[];
  doseWindows?: { timeOfDay: string; start: string; end: string }[] | null;
}

export interface TableMedication {
  id: string;
  name: string;
  dose: string;
  treatmentClass?: string;
  active: boolean;
  pausedAt: string | null;
  lastTakenAt: string | null;
  todayEventCount?: number;
  nextDueAt?: string | null;
  nextDueOverdue?: boolean;
  /** v1.16.10 — dose-derived stock from the list payload; null = inventory tracking off. */
  stockDosesRemaining?: number | null;
  schedules: TableSchedule[];
}

export type MedicationTableSortColumn =
  | "name"
  | "nextDue"
  | "compliance"
  | "stock";

export interface MedicationTableSort {
  column: MedicationTableSortColumn;
  direction: "asc" | "desc";
}

/**
 * Tri-state header click cycle: none → ascending → descending → none.
 * `null` = the manual (user-defined) order the page passed in.
 */
export function nextSortState(
  current: MedicationTableSort | null,
  column: MedicationTableSortColumn,
): MedicationTableSort | null {
  if (!current || current.column !== column) {
    return { column, direction: "asc" };
  }
  if (current.direction === "asc") return { column, direction: "desc" };
  return null;
}

/**
 * Client-side sort over the loaded list. Rows without a value for the
 * chosen column (no next due, no compliance row yet, inventory tracking
 * off) sort last in BOTH directions — an unknown must never outrank a
 * known value. `null` sort returns the input order untouched (the
 * manual order).
 */
export function sortMedicationRows<T extends TableMedication>(
  rows: readonly T[],
  sort: MedicationTableSort | null,
  shortRateById?: ReadonlyMap<string, number>,
  /** Active UI locale for name collation; omitted = runtime default. */
  locale?: string,
): T[] {
  if (!sort) return [...rows];
  const dir = sort.direction === "asc" ? 1 : -1;
  const value = (m: T): number | string | null => {
    switch (sort.column) {
      case "name":
        return m.name;
      case "nextDue": {
        if (!m.nextDueAt) return null;
        const ms = new Date(m.nextDueAt).getTime();
        return Number.isFinite(ms) ? ms : null;
      }
      case "compliance":
        return shortRateById?.get(m.id) ?? null;
      case "stock":
        return m.stockDosesRemaining ?? null;
    }
  };
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === "string" && typeof vb === "string") {
      return va.localeCompare(vb, locale, { sensitivity: "base" }) * dir;
    }
    return ((va as number) - (vb as number)) * dir;
  });
}

const LOW_STOCK_DOSES = 4;

interface MedicationTableProps {
  /** Active medications, already in the page's manual order. */
  activeMedications: TableMedication[];
  /** Inactive medications, already in the page's manual order; pinned after the active block. */
  inactiveMedications: TableMedication[];
  /** SSR-pinnable initial sort (tests); the header buttons own it after mount. */
  initialSort?: MedicationTableSort | null;
}

export function MedicationTable({
  activeMedications,
  inactiveMedications,
  initialSort = null,
}: MedicationTableProps) {
  const { t, locale } = useTranslations();
  const { user } = useAuth();
  const userTz = user?.timezone || "Europe/Berlin";
  const [sort, setSort] = useState<MedicationTableSort | null>(initialSort);
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);

  // Same reminder-thresholds source as the cards so the status pill
  // tiers identically on both presentations.
  const { data: thresholds } = useQuery({
    queryKey: queryKeys.settingsReminderThresholds(),
    queryFn: async () => {
      try {
        return await apiGet<{ lateMinutes: number; missedMinutes: number }>(
          "/api/settings/reminder-thresholds",
        );
      } catch {
        return null;
      }
    },
    staleTime: 5 * 60 * 1000,
  });

  // The whole batched compliance array — the Therapietreue sort needs
  // every row at once. Same key + fetcher as the per-row hook.
  const { data: complianceRows } = useMedicationComplianceSummaryAll();
  const shortRateById = new Map<string, number>(
    (complianceRows ?? []).map((row) => [
      row.medicationId,
      row.complianceDisplay?.short.rate ?? row.compliance7?.rate ?? 0,
    ]),
  );

  // Re-render once a minute so the status pill tracks wall-clock
  // progress — the cards tick on the same cadence.
  useEffect(() => {
    const interval = setInterval(forceUpdate, 60_000);
    return () => clearInterval(interval);
  }, []);

  const sortedActive = sortMedicationRows(
    activeMedications,
    sort,
    shortRateById,
    locale,
  );
  const sortedInactive = sortMedicationRows(
    inactiveMedications,
    sort,
    shortRateById,
    locale,
  );

  const lateMinutes = thresholds?.lateMinutes ?? 120;
  const missedMinutes = thresholds?.missedMinutes ?? 240;

  const columns: Array<{
    key: MedicationTableSortColumn | "status" | "actions";
    label: string;
    sortable: boolean;
    className?: string;
  }> = [
    {
      key: "name",
      label: t("medications.tableColName"),
      sortable: true,
      // Sticky first column: the name stays anchored while the row
      // scrolls horizontally on narrow viewports.
      className: "bg-card sticky left-0 z-10",
    },
    { key: "status", label: t("medications.tableColStatus"), sortable: false },
    { key: "nextDue", label: t("medications.tableColNextDose"), sortable: true },
    {
      key: "compliance",
      label: t("medications.tableColCompliance"),
      sortable: true,
    },
    { key: "stock", label: t("medications.tableColStock"), sortable: true },
    { key: "actions", label: t("medications.tableColActions"), sortable: false },
  ];

  function ariaSort(
    column: MedicationTableSortColumn,
  ): "ascending" | "descending" | "none" {
    if (!sort || sort.column !== column) return "none";
    return sort.direction === "asc" ? "ascending" : "descending";
  }

  return (
    <div className="bg-card border-border rounded-xl border">
      <Table>
        <caption className="sr-only">{t("medications.tableCaption")}</caption>
        <TableHeader>
          <TableRow>
            {columns.map((col) =>
              col.sortable ? (
                <TableHead
                  key={col.key}
                  scope="col"
                  aria-sort={ariaSort(col.key as MedicationTableSortColumn)}
                  className={col.className}
                >
                  <button
                    type="button"
                    onClick={() =>
                      setSort((current) =>
                        nextSortState(
                          current,
                          col.key as MedicationTableSortColumn,
                        ),
                      )
                    }
                    aria-label={t("medications.tableSortBy", {
                      column: col.label,
                    })}
                    className="hover:text-foreground focus-visible:ring-ring inline-flex min-h-8 items-center gap-1 rounded font-medium focus-visible:ring-2 focus-visible:outline-none"
                  >
                    {col.label}
                    {sort?.column === col.key ? (
                      sort.direction === "asc" ? (
                        <ArrowUp className="size-3.5" aria-hidden="true" />
                      ) : (
                        <ArrowDown className="size-3.5" aria-hidden="true" />
                      )
                    ) : (
                      <ChevronsUpDown
                        className="text-muted-foreground/60 size-3.5"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </TableHead>
              ) : (
                <TableHead key={col.key} scope="col" className={col.className}>
                  {col.label}
                </TableHead>
              ),
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedActive.map((med) => (
            <MedicationTableRowItem
              key={med.id}
              medication={med}
              userTz={userTz}
              lateMinutes={lateMinutes}
              missedMinutes={missedMinutes}
            />
          ))}
          {sortedInactive.map((med) => (
            <MedicationTableRowItem
              key={med.id}
              medication={med}
              userTz={userTz}
              lateMinutes={lateMinutes}
              missedMinutes={missedMinutes}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

interface MedicationTableRowItemProps {
  medication: TableMedication;
  userTz: string;
  lateMinutes: number;
  missedMinutes: number;
}

function MedicationTableRowItem({
  medication,
  userTz,
  lateMinutes,
  missedMinutes,
}: MedicationTableRowItemProps) {
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const weekdayLabel = useWeekdayLabel();

  // SAME mutation path as the cards — the shared take/skip hook with
  // failure toast + Undo. No card-specific follow-up here; the
  // injection-site prompt stays a card affordance.
  const { intakeLoading, recordIntake } = useMedicationIntake({ medication });

  // SAME batched compliance source as the cards.
  const { data: compliance } = useMedicationComplianceSummary(medication.id);
  const display = compliance?.complianceDisplay;
  const shortDays = display?.shortDays ?? 7;
  const longDays = display?.longDays ?? 30;
  const rateShort = display?.short.rate ?? compliance?.compliance7?.rate ?? 0;
  const rateLong = display?.long.rate ?? compliance?.compliance30?.rate ?? 0;
  const doseStatus = display?.currentDose.status ?? "upcoming";

  const sortedSchedules = [...medication.schedules].sort(
    (a, b) =>
      a.windowStart.localeCompare(b.windowStart) ||
      a.windowEnd.localeCompare(b.windowEnd),
  );
  const now = new Date();
  const nowZoned = toZonedDate(now, userTz);
  const nextDueMs = medication.nextDueAt
    ? new Date(medication.nextDueAt).getTime()
    : NaN;
  const nextAt = Number.isFinite(nextDueMs) ? nextDueMs : undefined;

  // The SAME served-next-due-gated pill reduction the cards run —
  // including the v1.16.6 `nextDue` gate so a rolling cadence whose
  // next dose is tomorrow can never paint an overdue pill today.
  const currentWindowStatus = reduceCurrentWindowStatus({
    schedules: sortedSchedules,
    nowBerlin: nowZoned,
    lateMinutes,
    missedMinutes,
    active: medication.active,
    lastTakenAt: medication.lastTakenAt,
    todayEventCount: medication.todayEventCount ?? 0,
    tz: userTz,
    nextDue:
      medication.nextDueAt === undefined
        ? undefined
        : nextAt !== undefined
          ? {
              at: new Date(nextAt),
              overdue: medication.nextDueOverdue === true,
            }
          : null,
  });

  // Same displayed-slot threading as the cards so the server records
  // THIS dose rather than snapping "now" to the nearest slot.
  const displayedSlot = resolveDisplayedSlotInstant({
    currentWindowStatus,
    nextDueAt: medication.nextDueAt,
    now,
    timeZone: userTz,
  });

  // Status cell — the card body's exact precedence: last-dose context
  // outranks the overdue escalation, which outranks the window pill.
  const overdueLabel =
    medication.active && doseStatus === "missed"
      ? t("medications.veryOverdue")
      : medication.active && doseStatus === "overdue"
        ? t("medications.overdue")
        : null;

  const statusCell =
    currentWindowStatus.status &&
    currentWindowStatus.takenEarlyDaysAgo != null ? (
      <MedicationStatusPill
        compact
        status={currentWindowStatus.status}
        windowStart={currentWindowStatus.window!.start}
        windowEnd={currentWindowStatus.window!.end}
        takenEarlyDaysAgo={currentWindowStatus.takenEarlyDaysAgo}
      />
    ) : overdueLabel ? (
      <span className="text-destructive text-sm font-medium">
        {overdueLabel}
      </span>
    ) : currentWindowStatus.status ? (
      <MedicationStatusPill
        compact
        status={currentWindowStatus.status}
        windowStart={currentWindowStatus.window!.start}
        windowEnd={currentWindowStatus.window!.end}
      />
    ) : (
      <span className="text-muted-foreground text-sm">–</span>
    );

  // Next-intake cell — the card's value logic, compacted: overdue slot
  // in calm amber, in-window shows the matched take-window range, a
  // future slot shows the relative day + canonical next-due time.
  const nextSchedule = sortedSchedules[0] ?? null;
  let nextCell: React.ReactNode = (
    <span className="text-muted-foreground">–</span>
  );
  if (medication.active) {
    if (medication.nextDueOverdue && nextAt) {
      nextCell = (
        <span className="font-medium text-amber-600 dark:text-amber-400">
          {t("medications.nextIntakeOverdue", {
            time: formatTime(new Date(nextAt).toISOString()),
          })}
        </span>
      );
    } else if (currentWindowStatus.status === "in_window") {
      nextCell = (
        <span>
          {formatTimeWindowRange(
            currentWindowStatus.window!.start,
            currentWindowStatus.window!.end,
            locale,
          )}
        </span>
      );
    } else if (nextAt) {
      const nextDate = toZonedDate(new Date(nextAt), userTz);
      const todayStr = `${nowZoned.getFullYear()}-${nowZoned.getMonth()}-${nowZoned.getDate()}`;
      const nextStr = `${nextDate.getFullYear()}-${nextDate.getMonth()}-${nextDate.getDate()}`;
      const tomorrow = new Date(nowZoned);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = `${tomorrow.getFullYear()}-${tomorrow.getMonth()}-${tomorrow.getDate()}`;
      const diffDays = Math.round(
        (nextDate.getTime() - nowZoned.getTime()) / (24 * 60 * 60 * 1000),
      );
      const dayLabel =
        nextStr === todayStr
          ? t("medications.today")
          : nextStr === tomorrowStr
            ? t("medications.tomorrow")
            : diffDays <= 5
              ? weekdayLabel(nextDate.getDay())
              : fmt.dateWithWeekday(nextDate);
      nextCell = (
        <span>
          {dayLabel}, {formatTime(new Date(nextAt).toISOString())}
        </span>
      );
    } else if (nextSchedule) {
      nextCell = (
        <span>
          {formatTimeWindowRange(
            nextSchedule.windowStart,
            nextSchedule.windowEnd,
            locale,
          )}
        </span>
      );
    }
  }

  // Therapietreue cell — the same two cadence-scaled windows the card
  // bars show, compacted to label + mini bar + percentage per row.
  const complianceCell = compliance ? (
    <div className="flex flex-col gap-1">
      {(
        [
          [shortDays, rateShort],
          [longDays, rateLong],
        ] as const
      ).map(([days, rate]) => (
        <div key={days} className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground w-8 shrink-0 tabular-nums">
            {t("medications.tableComplianceDays", { days })}
          </span>
          <Progress
            value={rate}
            className="h-1.5 w-14"
            aria-label={t("medications.complianceWindow", { days })}
          />
          <span className="w-9 text-right font-medium tabular-nums">
            {fmt.number(Math.round(rate))}%
          </span>
        </div>
      ))}
    </div>
  ) : (
    <div className="flex flex-col gap-1" aria-hidden="true">
      <Skeleton className="h-3.5 w-28" />
      <Skeleton className="h-3.5 w-28" />
    </div>
  );

  const stock = medication.stockDosesRemaining;
  const stockCell =
    stock === null || stock === undefined ? (
      <span className="text-muted-foreground">–</span>
    ) : (
      <span
        className={cn(
          "tabular-nums",
          stock === 0
            ? "text-destructive font-medium"
            : stock < LOW_STOCK_DOSES
              ? "text-warning font-medium"
              : undefined,
        )}
      >
        {stock === 1
          ? t("medications.tableStockDoseOne")
          : t("medications.tableStockDoses", { count: stock })}
      </span>
    );

  return (
    <TableRow className={cn(!medication.active && "opacity-60")}>
      {/* Sticky name column — opaque background so scrolled content
          passes underneath, not through. */}
      <TableCell className="bg-card sticky left-0 z-10">
        <Link
          href={`/medications/${medication.id}`}
          aria-label={t("medications.openDetailPage")}
          className="focus-visible:ring-ring block min-w-0 rounded focus-visible:ring-2 focus-visible:outline-none"
        >
          <span className="text-foreground block max-w-40 truncate text-sm font-medium sm:max-w-56">
            {medication.name}
          </span>
          <span className="text-muted-foreground block text-xs">
            {medication.dose}
            {!medication.active && <> · {t("common.inactive")}</>}
          </span>
        </Link>
      </TableCell>
      <TableCell>{statusCell}</TableCell>
      <TableCell className="text-sm">{nextCell}</TableCell>
      <TableCell>{medication.active ? complianceCell : <span className="text-muted-foreground text-sm">–</span>}</TableCell>
      <TableCell className="text-sm">{stockCell}</TableCell>
      <TableCell>
        {medication.active ? (
          <div className="flex gap-1.5">
            <Button
              size="icon"
              className="size-11 sm:size-9"
              onClick={() => recordIntake(false, displayedSlot)}
              disabled={!!intakeLoading}
              aria-label={t("medications.takeActionFor", {
                name: medication.name,
              })}
            >
              {intakeLoading === "take" ? (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <Check className="h-4 w-4" />
              )}
            </Button>
            <Button
              size="icon"
              variant="outline"
              className="size-11 sm:size-9"
              onClick={() => recordIntake(true, displayedSlot)}
              disabled={!!intakeLoading}
              aria-label={t("medications.skipActionFor", {
                name: medication.name,
              })}
            >
              {intakeLoading === "skip" ? (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <SkipForward className="h-4 w-4" />
              )}
            </Button>
          </div>
        ) : (
          <span className="text-muted-foreground text-sm">–</span>
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * Loading placeholder for the table view. Mirrors the loaded table's
 * shell (same container, same column count, same row height) so the
 * page reserves the footprint and does not jump when the rows resolve —
 * the table-view counterpart of `MedicationCardSkeleton`.
 */
export function MedicationTableSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="bg-card border-border rounded-xl border" aria-hidden="true">
      <Table>
        <TableHeader>
          <TableRow>
            {Array.from({ length: 6 }).map((_, i) => (
              <TableHead key={i}>
                <Skeleton className="h-4 w-16" />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }).map((_, i) => (
            <TableRow key={i}>
              <TableCell>
                <div className="space-y-1.5">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-16" />
                </div>
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-24" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-24" />
              </TableCell>
              <TableCell>
                <div className="space-y-1.5">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="h-3.5 w-28" />
                </div>
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-14" />
              </TableCell>
              <TableCell>
                <div className="flex gap-1.5">
                  <Skeleton className="size-11 rounded-md sm:size-9" />
                  <Skeleton className="size-11 rounded-md sm:size-9" />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
