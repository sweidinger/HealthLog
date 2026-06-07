"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Activity,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  MoreHorizontal,
} from "lucide-react";
import { Fragment, useId, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { formatDateOrRelative, formatDateTime } from "@/lib/format";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { CUMULATIVE_DAY_SUM_TYPES } from "@/lib/measurements/cumulative-day-sum";
import {
  invalidateKeys,
  measurementDependentKeys,
  queryKeys,
} from "@/lib/query-keys";
import {
  MEASUREMENT_NOTES_MAX_LENGTH,
  measurementSourceEnum,
} from "@/lib/validations/measurement";
import { DateInput, DateTimeInput } from "@/components/ui/date-input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  SortableHead,
  DeleteButton,
  SelectionActionBar,
  toggleId,
  toggleSelectAll,
  selectAllState,
  selectedIdsOnPage,
  selectedCountOnPage,
} from "@/components/data-list";
import {
  MEASUREMENT_TYPE_LABEL_KEYS as TYPE_LABEL_KEYS,
  MEASUREMENT_TYPE_ICONS as TYPE_ICONS,
  MEASUREMENT_TYPE_COLORS as TYPE_COLORS,
} from "./measurement-list-meta";

/**
 * v1.4.37 W7c — cumulative HK types whose list view collapses to one
 * row per user-TZ day with an expand-chevron drill-down to the
 * per-sample chunks. Mirrors the server-side
 * `CUMULATIVE_DAY_SUM_TYPES` so the route's `groupBy=day` branch and
 * the client's filter-detection agree on the same five identifiers.
 */
const CUMULATIVE_TYPES = new Set<string>(CUMULATIVE_DAY_SUM_TYPES);

interface Measurement {
  id: string;
  type: string;
  value: number;
  unit: string;
  source: string;
  measuredAt: string;
  notes: string | null;
  /**
   * v1.4.37 W7c — present only on collapsed daily rows returned by
   * `?type=…&groupBy=day`. Drives the expand chevron + the drill-down
   * fetch keyed by the user's calendar day.
   */
  dayKey?: string;
  sampleCount?: number;
  /**
   * v1.11.5 — present only on per-night SLEEP_DURATION rows. `value` is
   * the night's TIME ASLEEP in minutes; these fields carry the night's
   * context so the row reads as one night, not many stage values.
   */
  sleepStage?: string | null;
  napCount?: number;
  napAsleepMinutes?: number;
  awakenings?: number;
}

/**
 * v1.11.5 — format a minutes total as an "8h 12m" / "8 Std. 12 Min."
 * sleep headline.
 */
function formatSleepMinutes(total: number, locale: string): string {
  const hours = Math.floor(total / 60);
  const mins = Math.round(total - hours * 60);
  if (locale === "de") {
    return hours > 0 ? `${hours} Std. ${mins} Min.` : `${mins} Min.`;
  }
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

/** v1.11.5 — i18n labels for the sleep stages shown in the drill-down. */
function sleepStageLabel(
  stage: string | null | undefined,
  t: ReturnType<typeof useTranslations>["t"],
): string {
  switch (stage) {
    case "DEEP":
      return t("insights.sleep.stages.deep");
    case "REM":
      return t("insights.sleep.stages.rem");
    case "CORE":
      return t("insights.sleep.stages.core");
    case "ASLEEP":
      return t("insights.sleep.stages.asleep");
    case "AWAKE":
      return t("insights.sleep.stages.awake");
    case "IN_BED":
      return t("insights.sleep.stages.inBed");
    default:
      return stage ?? "";
  }
}

interface MeasurementListProps {
  onEdit?: (m: Measurement) => void;
  /**
   * v1.4.15 phase-C5: optional callback wired by the parent page so
   * the empty-state's "Add your first measurement" CTA opens the same
   * dialog the header button does. When undefined we hide the button
   * (fallback to the header CTA) instead of crashing.
   */
  onAddFirst?: () => void;
  /**
   * v1.8.5 — pin the list to a single `MeasurementType` and hide the
   * type selector. Used by the insights "all readings" subpage, which
   * already knows the metric from the route and wants a focused list
   * (pagination + inline edit/delete) rather than the global filter UI.
   * When set, the type `Select` is not rendered and every fetch is
   * scoped to this type; the count caption still shows.
   */
  lockedType?: string;
}

const PAGE_SIZE = 25;
// Input cap mirrors the server Zod bound. The list preview truncates at
// a shorter width so a long note does not stretch a list row.
const MAX_COMMENT_LENGTH = MEASUREMENT_NOTES_MAX_LENGTH;
const COMMENT_PREVIEW_LENGTH = 40;

function truncateComment(comment: string): string {
  if (comment.length <= COMMENT_PREVIEW_LENGTH) return comment;
  return `${comment.slice(0, COMMENT_PREVIEW_LENGTH - 1)}…`;
}

function toDateTimeLocalValue(isoString: string): string {
  const date = new Date(isoString);
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

/**
 * Render the `MeasurementSource` enum (`MANUAL` / `WITHINGS` / `IMPORT`
 * / `APPLE_HEALTH`) using the existing `measurements.source*`
 * translation keys instead of leaking the SCREAMING_SNAKE enum into
 * the table cell.
 */
function formatMeasurementSource(
  source: string,
  t: ReturnType<typeof useTranslations>["t"],
) {
  if (source === "WITHINGS") return t("measurements.sourceWithings");
  if (source === "IMPORT") return t("measurements.sourceImport");
  if (source === "MANUAL") return t("measurements.sourceManual");
  if (source === "APPLE_HEALTH") return t("measurements.sourceAppleHealth");
  if (source === "COMPUTED") return t("measurements.sourceComputed");
  if (source === "WHOOP") return t("measurements.sourceWhoop");
  if (source === "FITBIT") return t("measurements.sourceFitbit");
  return source;
}

/**
 * v1.15.13 — the `MeasurementSource` enum values offered in the
 * management-list source filter. Derived from the shared Zod enum so a
 * future source addition surfaces here automatically.
 */
const MEASUREMENT_SOURCE_OPTIONS = measurementSourceEnum.options;

/**
 * v1.15.13 — convert a `<input type="date">` value (YYYY-MM-DD) into the
 * offset-bearing ISO datetime the measurements list `from`/`to` params
 * require. `from` snaps to the local start-of-day, `to` to the local
 * end-of-day so an inclusive single-day range returns that whole day.
 */
function dayBoundaryIso(
  day: string,
  boundary: "start" | "end",
): string | undefined {
  if (!day) return undefined;
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return undefined;
  const date =
    boundary === "start"
      ? new Date(y, m - 1, d, 0, 0, 0, 0)
      : new Date(y, m - 1, d, 23, 59, 59, 999);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

/**
 * Per-source badge colour. `APPLE_HEALTH` gets the Dracula pink that
 * matches the iOS app's accent; everything else falls back to the
 * shadcn outline default (no class override).
 */
function sourceBadgeClass(source: string): string {
  if (source === "APPLE_HEALTH") {
    return "border-dracula-pink/50 bg-dracula-pink/15 text-dracula-pink";
  }
  return "";
}

export function MeasurementList({
  onEdit,
  onAddFirst,
  lockedType,
}: MeasurementListProps) {
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  // v1.8.5 — when `lockedType` is set the list is pinned to that metric
  // and the type selector is hidden; the filter state seeds from it.
  const [typeFilter, setTypeFilterRaw] = useState<string>(
    lockedType ?? "ALL",
  );
  // v1.15.13 — management-list source filter + optional date range.
  // `ALL` clears the source filter; empty date strings clear the bound.
  const [sourceFilter, setSourceFilterRaw] = useState<string>("ALL");
  const [fromDay, setFromDayRaw] = useState<string>("");
  const [toDay, setToDayRaw] = useState<string>("");
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<string>("measuredAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // v1.15.13 — page-scoped multi-select. Holds the ids selected on the
  // CURRENT page; cleared on any page / filter / sort change (per the
  // v1.15.x audit — no "select across 200k rows"). The bulk-delete
  // payload is intersected with the painted page ids, so it is always
  // page-bounded (≤ PAGE_SIZE) and well under the server's 200 cap.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(),
  );

  // v1.4.37 W7c — set of dayKeys whose drill-down is currently
  // expanded. Each key maps to a one-shot query that lazy-fetches
  // the per-sample rows for that calendar day on first open.
  const [expandedDayKeys, setExpandedDayKeys] = useState<Set<string>>(
    () => new Set(),
  );
  function toggleExpand(dayKey: string) {
    setExpandedDayKeys((prev) => {
      const next = new Set(prev);
      if (next.has(dayKey)) next.delete(dayKey);
      else next.add(dayKey);
      return next;
    });
  }

  const [editing, setEditing] = useState<Measurement | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editMeasuredAt, setEditMeasuredAt] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [editDeleteDialogOpen, setEditDeleteDialogOpen] = useState(false);
  // v1.4.27 MB3 — link the edit dialog error banner to the inputs via
  // `aria-describedby` so screen readers announce the validation
  // failure when the user submits an invalid value or timestamp.
  const editErrorId = useId();
  const editErrorDescriptor = editError ? editErrorId : undefined;
  // v1.4.27 R4 RC2 — Sheet-branch sticky-pinned footer slot.
  const editFormId = useId();
  const [editFooterEl, setEditFooterEl] = useState<HTMLDivElement | null>(
    null,
  );

  // v1.15.13 — every filter / page / sort change resets pagination to
  // page 1 AND clears the page-scoped selection (the rows it referred to
  // are about to unmount).
  const clearSelection = () => setSelectedIds(new Set());

  const setTypeFilter = (value: string) => {
    setTypeFilterRaw(value);
    setPage(1);
    clearSelection();
  };

  const setSourceFilter = (value: string) => {
    setSourceFilterRaw(value);
    setPage(1);
    clearSelection();
  };

  const setFromDay = (value: string) => {
    setFromDayRaw(value);
    setPage(1);
    clearSelection();
  };

  const setToDay = (value: string) => {
    setToDayRaw(value);
    setPage(1);
    clearSelection();
  };

  const goToPage = (updater: (p: number) => number) => {
    setPage(updater);
    clearSelection();
  };

  function toggleSort(column: string) {
    if (sortBy === column) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(column);
      setSortDir(column === "measuredAt" ? "desc" : "asc");
    }
    setPage(1);
    clearSelection();
  }

  // v1.4.37 W7c — when the type filter is a cumulative HK type
  // (steps, active energy, distance, flights, daylight) the list
  // collapses to one row per user-TZ day via the route's
  // `groupBy=day` mode. The chevron in the row drills back into the
  // per-sample chunks via a separate `dayKey=…` query. Matches the
  // Apple Health.app / Garmin / Withings pattern documented in
  // `.planning/research/v1437-step-aggregation.md` §"How the leaders
  // do it" — never list per-sample chunks as the default view.
  const isCumulativeFilter = CUMULATIVE_TYPES.has(typeFilter);
  // v1.11.5 — SLEEP_DURATION is collapsed server-side to one row per
  // night (TIME ASLEEP), so the list paints per-night rows with a
  // chevron drilling into the night's stage segments. Like the
  // cumulative branch it returns a single page of synthesised rows.
  const isSleepFilter = typeFilter === "SLEEP_DURATION";
  const isDayGroupedFilter = isCumulativeFilter || isSleepFilter;

  // v1.15.13 — derive the ISO datetime window the list `from`/`to`
  // params require from the two date inputs (local start/end of day).
  const fromIso = dayBoundaryIso(fromDay, "start");
  const toIso = dayBoundaryIso(toDay, "end");
  const sourceEq = sourceFilter === "ALL" ? undefined : sourceFilter;
  const listMode: "raw" | "groupBy=day" | "sleep-night" = isSleepFilter
    ? "sleep-night"
    : isCumulativeFilter
      ? "groupBy=day"
      : "raw";

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.measurementsList({
      type: typeFilter === "ALL" ? undefined : typeFilter,
      sourceEq,
      from: fromIso,
      to: toIso,
      page,
      sortBy,
      sortDir,
      mode: listMode,
    }),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (typeFilter !== "ALL") params.set("type", typeFilter);
      if (sourceEq) params.set("sourceEq", sourceEq);
      if (fromIso) params.set("from", fromIso);
      if (toIso) params.set("to", toIso);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String((page - 1) * PAGE_SIZE));
      params.set("sortBy", sortBy);
      params.set("sortDir", sortDir);
      if (isCumulativeFilter) {
        params.set("groupBy", "day");
        // The collapsed mode synthesises one row per day from the
        // window of raw samples. Use the server-side ceiling (5000)
        // so a chatty pre-drain Apple-Watch account (≈200 per-sample
        // chunks/day on the busiest days) still fills several screens
        // of daily rows before the nightly drain reduces each day to
        // a single `stats:` row. Post-drain the scan is trivially
        // short — every day reduces to 1 row.
        params.set("limit", "5000");
        // The synthesised rows live entirely in the collapse branch
        // — pagination/offset don't apply on the server side. Reset
        // the offset so a sort-direction flip doesn't paginate into
        // an empty slice.
        params.set("offset", "0");
      } else if (isSleepFilter) {
        // v1.11.5 — the route auto-collapses SLEEP_DURATION to one row
        // per night (no `groupBy` param needed). Request a wide limit
        // so the per-night list spans the trailing year the route
        // bounds the read to; offset doesn't apply to the synthesised
        // rows.
        params.set("limit", "366");
        params.set("offset", "0");
      }
      const res = await fetch(`/api/measurements?${params}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const json = await res.json();
      return json.data as {
        measurements: Measurement[];
        meta: { total: number };
      };
    },
    enabled: isAuthenticated,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/measurements/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      void invalidateKeys(queryClient, measurementDependentKeys);
    },
  });

  // v1.15.13 — page-scoped bulk soft-delete. Posts the selected ids
  // (intersected with the painted page) to the bulk-delete route, then
  // invalidates the same dependent-key bundle the single delete busts so
  // the dashboard / insights / chart caches stay in lockstep.
  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const res = await fetch("/api/measurements/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error("Bulk delete failed");
      const json = (await res.json()) as { data: { deleted: number } };
      return json.data.deleted;
    },
    onSuccess: async (deleted) => {
      await invalidateKeys(queryClient, measurementDependentKeys);
      clearSelection();
      toast.success(t("measurements.bulkDeleteSuccess", { count: String(deleted) }));
    },
    onError: () => {
      toast.error(t("measurements.bulkDeleteError"));
    },
  });

  const pageIds = (data?.measurements ?? [])
    // Synthetic day-grouped / sleep-night rows aren't individually
    // deletable (they collapse many raw rows behind a `dayKey`), so they
    // are excluded from the selectable set.
    .filter((m) => !(m.dayKey !== undefined && m.sampleCount !== undefined))
    .map((m) => m.id);

  // Selection is held as a raw id set but every read intersects it with
  // the painted page (`selectAllState` / `selectedCountOnPage` /
  // `selectedIdsOnPage`), so an id that falls off the page after a
  // refetch (e.g. a single-row delete) simply stops counting — no stale
  // selection survives a page / filter / sort change either, since those
  // call `clearSelection()`. No prune effect is needed.
  const selectAll = selectAllState(selectedIds, pageIds);
  const selectedOnPage = selectedCountOnPage(selectedIds, pageIds);

  function onToggleRow(id: string) {
    setSelectedIds((prev) => toggleId(prev, id));
  }

  function onToggleSelectAll() {
    setSelectedIds((prev) => toggleSelectAll(prev, pageIds));
  }

  function onConfirmBulkDelete() {
    const ids = selectedIdsOnPage(selectedIds, pageIds);
    if (ids.length === 0) return;
    bulkDeleteMutation.mutate(ids);
  }

  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      value,
      measuredAt,
      notes,
    }: {
      id: string;
      value: number;
      measuredAt: string;
      notes: string | null;
    }) => {
      const res = await fetch(`/api/measurements/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          value,
          measuredAt,
          notes,
        }),
      });

      const json = (await res.json()) as {
        error?: string;
        meta?: { errorCode?: string };
      };
      if (!res.ok) {
        // v1.4.28 FB-B1 — the PUT route now returns a 409 with
        // `meta.errorCode === "measurement.duplicate_timestamp"` when
        // the edit collides with an existing row's
        // `(type, measuredAt, source, sleepStage)` tuple. Forward the
        // code alongside the message so `onError` can pick the
        // localised string.
        const err = new Error(json.error ?? "Update failed") as Error & {
          errorCode?: string;
          status?: number;
        };
        err.errorCode = json.meta?.errorCode;
        err.status = res.status;
        throw err;
      }
    },
    onSuccess: async () => {
      await invalidateKeys(queryClient, measurementDependentKeys);
      setEditing(null);
      setEditError(null);
    },
    onError: (err) => {
      const errWithCode = err as Error & { errorCode?: string };
      if (errWithCode.errorCode === "measurement.duplicate_timestamp") {
        setEditError(t("measurements.duplicateTimestamp"));
        return;
      }
      setEditError(
        err instanceof Error ? err.message : t("measurements.saveError"),
      );
    },
  });

  // v1.4.37 W7c — the collapsed daily view paints up to 5000
  // synthesised rows in one shot (one row per day for the
  // configured window). Pagination would force a second server
  // round-trip that re-fires the same scan, so the day-grouped
  // path collapses to a single page. Per-sample lists continue to
  // paginate at PAGE_SIZE = 25.
  const totalPages =
    data && !isDayGroupedFilter
      ? Math.ceil(data.meta.total / PAGE_SIZE)
      : 0;

  function startEdit(measurement: Measurement) {
    if (onEdit) {
      onEdit(measurement);
      return;
    }

    setEditing(measurement);
    setEditValue(String(measurement.value));
    setEditMeasuredAt(toDateTimeLocalValue(measurement.measuredAt));
    setEditNotes((measurement.notes ?? "").slice(0, MAX_COMMENT_LENGTH));
    setEditError(null);
  }

  function closeEdit() {
    if (updateMutation.isPending || deleteMutation.isPending) return;
    setEditing(null);
    setEditError(null);
    setEditDeleteDialogOpen(false);
  }

  async function deleteEditingMeasurement() {
    if (!editing) return;

    try {
      setEditError(null);
      await deleteMutation.mutateAsync(editing.id);
      closeEdit();
    } catch {
      setEditError(t("measurements.deleteError"));
    }
  }

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;

    const parsedValue = Number(editValue);
    if (!Number.isFinite(parsedValue)) {
      setEditError(t("measurements.invalidValue"));
      return;
    }

    const measuredDate = new Date(editMeasuredAt);
    if (Number.isNaN(measuredDate.getTime())) {
      setEditError(t("measurements.invalidTimestamp"));
      return;
    }

    setEditError(null);
    updateMutation.mutate({
      id: editing.id,
      value: parsedValue,
      measuredAt: measuredDate.toISOString(),
      notes: editNotes.trim() ? editNotes.trim() : null,
    });
  }

  if (!isAuthenticated) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("measurements.loginRequired")}
      </p>
    );
  }

  return (
    <>
      <div className="space-y-4">
        {/* v1.4.27 MB7 / CF-46 — the filter row stacks the SelectTrigger
            and the count caption vertically on `<sm` so the trigger
            fills the column and the count drops to a separate line.
            Pre-fix the trigger had a fixed `w-48` (192 px) which on
            Pixel 5 (375 px content width) left only ~120 px for the
            count, which wrapped to 2 lines. */}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
            {lockedType ? (
              // v1.8.5 — the insights "all readings" subpage knows the
              // metric from the route, so the global type selector is
              // suppressed; the count caption still anchors the column.
              <span className="sr-only">{t("measurements.filterByType")}</span>
            ) : (
              <div className="flex flex-col gap-1">
                <Label className="text-muted-foreground text-xs">
                  {t("measurements.filterByType")}
                </Label>
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger
                    className="w-full sm:w-44"
                    aria-label={t("measurements.filterByType")}
                  >
                    <SelectValue placeholder={t("measurements.allTypes")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">
                      {t("measurements.allTypes")}
                    </SelectItem>
                    {Object.entries(TYPE_LABEL_KEYS).map(([val, labelKey]) => (
                      <SelectItem key={val} value={val}>
                        {t(labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* v1.15.13 — source filter + date range. Suppressed on the
                locked-type insights subpage, which wants a focused list
                scoped to the route's single metric (matches the type-
                selector suppression above). */}
            {!lockedType && (
              <>
                <div className="flex flex-col gap-1">
                  <Label className="text-muted-foreground text-xs">
                    {t("measurements.filterBySource")}
                  </Label>
                  <Select value={sourceFilter} onValueChange={setSourceFilter}>
                    <SelectTrigger
                      className="w-full sm:w-40"
                      aria-label={t("measurements.filterBySource")}
                    >
                      <SelectValue placeholder={t("dataList.allSources")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">
                        {t("dataList.allSources")}
                      </SelectItem>
                      {MEASUREMENT_SOURCE_OPTIONS.map((src) => (
                        <SelectItem key={src} value={src}>
                          {formatMeasurementSource(src, t)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1">
                  <Label
                    htmlFor="measurements-from"
                    className="text-muted-foreground text-xs"
                  >
                    {t("dataList.dateFrom")}
                  </Label>
                  <DateInput
                    id="measurements-from"
                    className="w-full sm:w-40"
                    value={fromDay}
                    max={toDay || undefined}
                    onChange={(e) => setFromDay(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label
                    htmlFor="measurements-to"
                    className="text-muted-foreground text-xs"
                  >
                    {t("dataList.dateTo")}
                  </Label>
                  <DateInput
                    id="measurements-to"
                    className="w-full sm:w-40"
                    value={toDay}
                    min={fromDay || undefined}
                    onChange={(e) => setToDay(e.target.value)}
                  />
                </div>
              </>
            )}
          </div>

          {data?.meta?.total !== undefined && (
            <span className="text-muted-foreground text-sm">
              {t("measurements.measurementCount", {
                count: fmt.integer(data.meta.total),
              })}
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
          </div>
        ) : !data?.measurements?.length ? (
          // v1.4.15 phase-C5: replaces the bare-text empty rectangle.
          // Filter-aware copy distinguishes brand-new accounts ("no
          // measurements yet") from filtered-out lists ("no measurements
          // match this filter") and exposes the right CTA for each
          // case.
          <EmptyState
            icon={<Activity className="size-6" />}
            title={
              typeFilter === "ALL" || lockedType
                ? t("measurements.emptyTitle")
                : t("measurements.emptyFilteredTitle")
            }
            description={
              typeFilter === "ALL" || lockedType
                ? t("measurements.emptyDescription")
                : t("measurements.emptyFilteredDescription")
            }
            action={
              // v1.8.5 — a locked-type list has no "reset filter" path;
              // the metric is fixed by the route.
              typeFilter !== "ALL" && !lockedType ? (
                <Button
                  variant="outline"
                  onClick={() => setTypeFilter("ALL")}
                >
                  {t("measurements.emptyResetFilter")}
                </Button>
              ) : onAddFirst ? (
                <Button onClick={onAddFirst}>
                  <Plus className="mr-1 h-4 w-4" />
                  {t("measurements.emptyAddFirst")}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            {/* Desktop table */}
            <div className="bg-card border-border hidden overflow-hidden rounded-lg border md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10 pl-4">
                      {/* v1.15.13 — select-all-on-page header checkbox. */}
                      <Checkbox
                        checked={
                          selectAll === "all"
                            ? true
                            : selectAll === "some"
                              ? "indeterminate"
                              : false
                        }
                        disabled={pageIds.length === 0}
                        onCheckedChange={onToggleSelectAll}
                        aria-label={t("dataList.selectAll")}
                      />
                    </TableHead>
                    <TableHead className="w-28">
                      {t("measurements.type")}
                    </TableHead>
                    <SortableHead
                      column="value"
                      label={t("measurements.value")}
                      currentSort={sortBy}
                      currentDir={sortDir}
                      onSort={toggleSort}
                    />
                    <SortableHead
                      column="measuredAt"
                      label={t("measurements.date")}
                      currentSort={sortBy}
                      currentDir={sortDir}
                      onSort={toggleSort}
                    />
                    <TableHead className="w-56">
                      {t("measurements.comment")}
                    </TableHead>
                    <SortableHead
                      column="source"
                      label={t("measurements.source")}
                      currentSort={sortBy}
                      currentDir={sortDir}
                      onSort={toggleSort}
                      className="w-20"
                    />
                    <TableHead className="w-20 pr-4 text-right">
                      {t("measurements.actions")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.measurements.map((m) => {
                    const isGrouped =
                      m.dayKey !== undefined && m.sampleCount !== undefined;
                    // v1.11.5 — sleep night rows are grouped (chevron
                    // drills into the stage segments) but render a
                    // sleep-aware headline + nap caption, not the
                    // cumulative "daily total" caption.
                    const isSleep = m.type === "SLEEP_DURATION";
                    const isExpanded = isGrouped
                      ? expandedDayKeys.has(m.dayKey as string)
                      : false;
                    // v1.4.38 W-D P1-1 — stable drill-down id so the
                    // disclosure chevron can thread aria-controls to the
                    // expanded panel. dayKey is unique per row when
                    // grouped; fall back to m.id otherwise.
                    const drilldownId = `drilldown-desktop-${m.dayKey ?? m.id}`;
                    const isSelected = selectedIds.has(m.id);
                    return (
                      <Fragment key={m.id}>
                        <TableRow data-state={isSelected ? "selected" : undefined}>
                          <TableCell className="pl-4">
                            {/* Grouped/synthetic rows aren't individually
                                deletable, so they have no checkbox. */}
                            {!isGrouped && (
                              <Checkbox
                                checked={isSelected}
                                onCheckedChange={() => onToggleRow(m.id)}
                                aria-label={t("dataList.selectRow")}
                              />
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="secondary"
                              className={TYPE_COLORS[m.type] ?? ""}
                            >
                              {TYPE_LABEL_KEYS[m.type]
                                ? t(TYPE_LABEL_KEYS[m.type])
                                : m.type}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-semibold tabular-nums">
                            {/* v1.4.39.3 — non-grouped rows render the
                                stored value with its native precision
                                (`fmt.number` honours up to 3 fraction
                                digits by default, drops trailing zeros)
                                so a 78.4 kg weight reading stops
                                truncating to "78". Grouped rows are
                                cumulative-type day aggregates (steps,
                                distance, etc.) and stay on `fmt.integer`
                                because the underlying readings are
                                integer-only by definition.
                                v1.11.5 — sleep rows render the night's
                                TIME ASLEEP as "8h 12m" + a nap caption. */}
                            {isSleep ? (
                              <>
                                {formatSleepMinutes(m.value, locale)}
                                <SleepNightCaption m={m} />
                              </>
                            ) : (
                              <>
                                {isGrouped
                                  ? fmt.integer(m.value)
                                  : fmt.number(m.value)}{" "}
                                {m.unit}
                                {isGrouped && (
                                  <span className="text-muted-foreground ml-2 text-xs font-normal">
                                    {t("measurements.dailyTotalCaption", {
                                      count: fmt.integer(
                                        m.sampleCount as number,
                                      ),
                                    })}
                                  </span>
                                )}
                              </>
                            )}
                          </TableCell>
                          {/*
                            v1.4.43 QoL (L8) — `formatDateOrRelative`
                            renders timestamps inside the last 24 h
                            as "vor 3 min" so a fresh entry visible
                            on the dashboard briefing and on the
                            list view never disagrees about how to
                            phrase "when".
                          */}
                          <TableCell className="text-muted-foreground text-sm">
                            {formatDateOrRelative(m.measuredAt, t)}
                          </TableCell>
                          <TableCell className="text-sm">
                            {m.notes ? (
                              <span title={m.notes}>
                                {truncateComment(m.notes)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {m.source !== "MANUAL" && (
                              <Badge
                                variant="outline"
                                data-testid="measurement-source-badge"
                                className={`text-xs ${sourceBadgeClass(m.source)}`.trim()}
                              >
                                {formatMeasurementSource(m.source, t)}
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="pr-4 text-right">
                            <div className="flex items-center justify-end gap-1">
                              {isGrouped ? (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-10 w-10"
                                  data-testid="measurement-day-expand"
                                  onClick={() =>
                                    toggleExpand(m.dayKey as string)
                                  }
                                  aria-expanded={isExpanded}
                                  aria-controls={drilldownId}
                                  aria-label={
                                    isExpanded
                                      ? t("measurements.collapseDay")
                                      : t("measurements.expandDay")
                                  }
                                >
                                  <ChevronDown
                                    className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                                  />
                                </Button>
                              ) : (
                                <>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-10 w-10"
                                    onClick={() => startEdit(m)}
                                    aria-label={t("common.edit")}
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </Button>
                                  <DeleteButton
                                    onConfirm={() =>
                                      deleteMutation.mutate(m.id)
                                    }
                                    title={t("measurements.deleteConfirmTitle")}
                                    description={t(
                                      "measurements.deleteConfirmDescription",
                                    )}
                                  />
                                </>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                        {isGrouped && isExpanded && (
                          <TableRow id={drilldownId}>
                            <TableCell colSpan={7} className="p-0">
                              <DayDrillDown
                                type={m.type}
                                dayKey={m.dayKey as string}
                                unit={m.unit}
                                layout="desktop"
                              />
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Mobile list */}
            <div className="space-y-2 md:hidden">
              {data.measurements.map((m) => {
                const Icon = TYPE_ICONS[m.type];
                const isGrouped =
                  m.dayKey !== undefined && m.sampleCount !== undefined;
                const isSleep = m.type === "SLEEP_DURATION";
                const isExpanded = isGrouped
                  ? expandedDayKeys.has(m.dayKey as string)
                  : false;
                // v1.4.38 W-D P1-1 — see desktop counterpart.
                const drilldownId = `drilldown-mobile-${m.dayKey ?? m.id}`;
                const isSelected = selectedIds.has(m.id);
                return (
                  <div
                    key={m.id}
                    data-state={isSelected ? "selected" : undefined}
                    className="bg-card border-border rounded-lg border p-3 data-[state=selected]:border-dracula-purple/60 data-[state=selected]:bg-dracula-purple/5"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 overflow-hidden">
                        {/* v1.15.13 — multi-select checkbox in a 44px tap
                            target; absent for synthetic grouped rows. */}
                        {!isGrouped && (
                          // v1.15.13 MEDIUM-1 — a Radix Checkbox renders a
                          // 16px `<button role=checkbox>`; a wrapping
                          // `<label>` does NOT forward taps to a button (label
                          // forwarding only works for native form controls),
                          // so the effective tap target was 16px (fails WCAG
                          // 2.5.5). The 44px button below owns the whole hit
                          // area and is the single toggle source; the inner
                          // Checkbox is a `pointer-events-none` controlled
                          // visual, so a tap can fire the handler exactly once.
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={isSelected}
                            aria-label={t("dataList.selectRow")}
                            onClick={() => onToggleRow(m.id)}
                            className="focus-visible:ring-ring/50 flex size-11 shrink-0 items-center justify-center rounded focus-visible:ring-2 focus-visible:outline-none"
                          >
                            <Checkbox
                              checked={isSelected}
                              tabIndex={-1}
                              aria-hidden="true"
                              className="pointer-events-none"
                            />
                          </button>
                        )}
                        {Icon && (
                          <div
                            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${TYPE_COLORS[m.type] ?? ""}`}
                          >
                            <Icon className="h-4 w-4" />
                          </div>
                        )}
                        <div className="min-w-0">
                          {/* v1.4.27 MB7 / CF-76 — bump the metadata
                              badges from `text-[10px]` to `text-[11px]`
                              so the legibility floor (12 px is the
                              mobile baseline; 11 px is the lowest
                              tolerated value for non-primary chrome)
                              holds across the row. */}
                          {(m.type === "BLOOD_PRESSURE_SYS" ||
                            m.type === "BLOOD_PRESSURE_DIA") && (
                            <Badge
                              variant="outline"
                              className="mr-1.5 h-5 px-1 text-[11px]"
                            >
                              {t(TYPE_LABEL_KEYS[m.type])}
                            </Badge>
                          )}
                          <span className="font-semibold tabular-nums">
                            {/* v1.4.39.3 — mirror the desktop table:
                                grouped daily aggregates stay integer,
                                non-grouped single readings render with
                                their native decimal precision so
                                "78.4 kg" no longer truncates to "78".
                                v1.11.5 — sleep rows render TIME ASLEEP. */}
                            {isSleep ? (
                              formatSleepMinutes(m.value, locale)
                            ) : (
                              <>
                                {isGrouped
                                  ? fmt.integer(m.value)
                                  : fmt.number(m.value)}{" "}
                                {m.unit}
                              </>
                            )}
                          </span>
                          {isSleep ? (
                            <SleepNightCaption m={m} />
                          ) : (
                            isGrouped && (
                              <span className="text-muted-foreground ml-1.5 text-[11px]">
                                {t("measurements.dailyTotalCaption", {
                                  count: fmt.integer(m.sampleCount as number),
                                })}
                              </span>
                            )
                          )}
                          <p className="text-muted-foreground truncate text-xs">
                            {/*
                              v1.4.43 QoL (L8) — see desktop
                              counterpart at the same `measuredAt`
                              site. Relative under 24 h, absolute
                              older.
                            */}
                            <span>{formatDateOrRelative(m.measuredAt, t)}</span>
                            {m.source !== "MANUAL" && (
                              <Badge
                                variant="outline"
                                data-testid="measurement-source-badge"
                                className={`ml-1.5 h-4 px-1 text-[11px] ${sourceBadgeClass(m.source)}`.trim()}
                              >
                                {formatMeasurementSource(m.source, t)}
                              </Badge>
                            )}
                          </p>
                          {m.notes && (
                            <p className="text-muted-foreground truncate text-xs">
                              {truncateComment(m.notes)}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {isGrouped ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-11"
                            data-testid="measurement-day-expand"
                            onClick={() => toggleExpand(m.dayKey as string)}
                            aria-expanded={isExpanded}
                            aria-controls={drilldownId}
                            aria-label={
                              isExpanded
                                ? t("measurements.collapseDay")
                                : t("measurements.expandDay")
                            }
                          >
                            <ChevronDown
                              className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                            />
                          </Button>
                        ) : (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-11"
                              onClick={() => startEdit(m)}
                              aria-label={t("common.edit")}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <DeleteButton
                              className="size-11"
                              iconClassName="h-4 w-4"
                              onConfirm={() => deleteMutation.mutate(m.id)}
                              title={t("measurements.deleteConfirmTitle")}
                              description={t(
                                "measurements.deleteConfirmDescription",
                              )}
                            />
                          </>
                        )}
                      </div>
                    </div>
                    {isGrouped && isExpanded && (
                      <div id={drilldownId}>
                        <DayDrillDown
                          type={m.type}
                          dayKey={m.dayKey as string}
                          unit={m.unit}
                          layout="mobile"
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* v1.15.13 — page-scoped multi-select action bar. */}
        <SelectionActionBar
          count={selectedOnPage}
          onClear={clearSelection}
          onConfirmDelete={onConfirmBulkDelete}
          isDeleting={bulkDeleteMutation.isPending}
          confirmTitle={t("measurements.bulkDeleteConfirmTitle", {
            count: String(selectedOnPage),
          })}
          confirmBody={t("measurements.bulkDeleteConfirmBody", {
            count: String(selectedOnPage),
          })}
        />

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-sm">
              {t("measurements.pageInfo", {
                page: String(page),
                total: String(totalPages),
              })}
            </span>
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="size-11"
                disabled={page <= 1}
                onClick={() => goToPage((p) => p - 1)}
                aria-label={t("measurements.previousPage")}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-11"
                disabled={page >= totalPages}
                onClick={() => goToPage((p) => p + 1)}
                aria-label={t("measurements.nextPage")}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      <ResponsiveSheet
        open={!!editing}
        onOpenChange={(open) => !open && closeEdit()}
        title={t("measurements.editMeasurement")}
        footer={<div ref={setEditFooterEl} className="flex w-full" />}
      >
          {editing && (
            <form
              id={editFormId}
              onSubmit={submitEdit}
              className="space-y-4"
            >
              <div className="flex items-center gap-1.5">
                <Label className="shrink-0">{t("measurements.type")}</Label>
                <span className="text-sm leading-none font-medium">
                  {TYPE_LABEL_KEYS[editing.type]
                    ? t(TYPE_LABEL_KEYS[editing.type])
                    : editing.type}
                </span>
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-value">
                  {t("measurements.valueWithUnit", { unit: editing.unit })}
                </Label>
                <Input
                  id="edit-value"
                  type="number"
                  enterKeyHint="next"
                  step="any"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  required
                  aria-required="true"
                  aria-invalid={!!editError || undefined}
                  aria-describedby={editErrorDescriptor}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-measuredAt">
                  {t("measurements.timestamp")}
                </Label>
                <DateTimeInput
                  id="edit-measuredAt"
                  value={editMeasuredAt}
                  onChange={(e) => setEditMeasuredAt(e.target.value)}
                  required
                  aria-required="true"
                  aria-invalid={!!editError || undefined}
                  aria-describedby={editErrorDescriptor}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="edit-notes">
                    {t("measurements.notes")} ({t("common.optional")})
                  </Label>
                  <span className="text-muted-foreground text-xs">
                    {editNotes.length}/{MAX_COMMENT_LENGTH}
                  </span>
                </div>
                <Input
                  id="edit-notes"
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  maxLength={MAX_COMMENT_LENGTH}
                  enterKeyHint="done"
                  autoCapitalize="sentences"
                />
              </div>

              {editError && (
                <div
                  id={editErrorId}
                  role="alert"
                  aria-live="assertive"
                  className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm"
                >
                  {editError}
                </div>
              )}

              {editFooterEl
                ? createPortal(
                    <div className="flex w-full items-center justify-between gap-2">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="size-11"
                            disabled={
                              updateMutation.isPending ||
                              deleteMutation.isPending
                            }
                            aria-label={t("common.moreOptions")}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setEditDeleteDialogOpen(true)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            {t("common.delete")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>

                      {/*
                        v1.4.43 QoL (L7) — `[Cancel] [Save]` order is
                        iOS-first intentional per Apple HIG, which
                        puts the primary / confirmation action
                        rightmost. iOS is the load-bearing mobile
                        target for HealthLog and the web shell renders
                        desktop + iOS PWA from the same component, so
                        the current order survives. Do NOT flip to
                        `[Save] [Cancel]` in a future "Android parity"
                        refactor — fork a platform-specific shell
                        instead if Android becomes a real audience.
                      */}
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={closeEdit}
                          disabled={
                            updateMutation.isPending ||
                            deleteMutation.isPending
                          }
                        >
                          {t("common.cancel")}
                        </Button>
                        <Button
                          type="submit"
                          form={editFormId}
                          disabled={
                            updateMutation.isPending ||
                            deleteMutation.isPending
                          }
                        >
                          {updateMutation.isPending ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
                          ) : null}
                          {t("common.save")}
                        </Button>
                      </div>
                    </div>,
                    editFooterEl,
                  )
                : null}

              <AlertDialog
                open={editDeleteDialogOpen}
                onOpenChange={setEditDeleteDialogOpen}
              >
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("measurements.deleteConfirmTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("measurements.deleteConfirmDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={deleteMutation.isPending}>
                      {t("common.cancel")}
                    </AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={deleteEditingMeasurement}
                      disabled={deleteMutation.isPending}
                    >
                      {deleteMutation.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
                      ) : null}
                      {t("common.delete")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </form>
          )}
      </ResponsiveSheet>
    </>
  );
}

/**
 * v1.4.37 W7c — lazy drill-down for a collapsed cumulative-type day.
 * Fires a separate `GET /api/measurements?type=…&dayKey=…` only when
 * the row is expanded; the result is rendered as a nested list of the
 * per-sample chunks that summed into the parent row's daily total.
 */
function DayDrillDown({
  type,
  dayKey,
  unit,
  layout,
}: {
  type: string;
  dayKey: string;
  unit: string;
  layout: "desktop" | "mobile";
}) {
  const { t, locale } = useTranslations();
  const { isAuthenticated } = useAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: ["measurement-drilldown", type, dayKey],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("type", type);
      params.set("dayKey", dayKey);
      params.set("sortDir", "asc");
      const res = await fetch(`/api/measurements?${params}`);
      if (!res.ok) throw new Error("Failed to fetch drill-down");
      const json = await res.json();
      return json.data as { measurements: Measurement[] };
    },
    enabled: isAuthenticated,
    // The drill-down is per-day — once fetched it rarely needs to
    // re-fetch (the underlying day has already stabilised for
    // anything older than the drain's 36 h cutoff). Keep it cached
    // for the session.
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-2 text-xs">
        <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
        {t("common.loading")}
      </div>
    );
  }
  if (error) {
    return (
      <div className="text-destructive py-2 text-xs">
        {t("measurements.loadError")}
      </div>
    );
  }
  const rows = data?.measurements ?? [];
  if (rows.length === 0) {
    return (
      <div className="text-muted-foreground py-2 text-xs">
        {t("measurements.emptyDescription")}
      </div>
    );
  }
  // v1.11.5 — for SLEEP_DURATION the drill-down rows are stage segments;
  // render the stage label + minutes instead of a bare value + unit.
  const isSleep = type === "SLEEP_DURATION";
  if (layout === "desktop") {
    return (
      <div className="bg-muted/40 space-y-1 p-2">
        {rows.map((s) => (
          <div
            key={s.id}
            className="flex items-center justify-between gap-3 px-2 py-1 text-xs"
          >
            <span className="text-muted-foreground tabular-nums">
              {isSleep ? sleepStageLabel(s.sleepStage, t) : formatDateTime(s.measuredAt)}
            </span>
            <span className="font-medium tabular-nums">
              {isSleep ? formatSleepMinutes(s.value, locale) : `${s.value} ${unit}`}
            </span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="bg-muted/40 mt-2 space-y-1 rounded-md p-2">
      {rows.map((s) => (
        <div
          key={s.id}
          className="flex items-center justify-between gap-2 px-1 py-1 text-xs"
        >
          <span className="text-muted-foreground tabular-nums">
            {isSleep ? sleepStageLabel(s.sleepStage, t) : formatDateTime(s.measuredAt)}
          </span>
          <span className="font-medium tabular-nums">
            {isSleep ? formatSleepMinutes(s.value, locale) : `${s.value} ${unit}`}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * v1.11.5 — sub-caption for a per-night sleep row: surfaces the nap count
 * (naps are separate from the main night per the nap convention) and the
 * night's mid-sleep awakenings when present.
 */
function SleepNightCaption({ m }: { m: Measurement }) {
  const { t } = useTranslations();
  const napCount = m.napCount ?? 0;
  const awakenings = m.awakenings ?? 0;
  const parts: string[] = [];
  if (napCount > 0) {
    parts.push(t("measurements.sleepNapCaption", { count: String(napCount) }));
  }
  if (awakenings > 0) {
    parts.push(
      t("measurements.sleepAwakeningsCaption", { count: String(awakenings) }),
    );
  }
  if (parts.length === 0) return null;
  return (
    <span className="text-muted-foreground ml-2 text-xs font-normal">
      {parts.join(" · ")}
    </span>
  );
}

