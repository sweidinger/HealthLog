"use client";

/**
 * v1.15.18 — per-dose configurable on-time WINDOW editor (Marc's headline
 * lever). Shared verbatim by the Zeitplan tab (everyday inline edit) and
 * the wizard's Step 7 (structural create / edit) so the window semantics
 * are identical wherever a dose time is set.
 *
 * Per dose time the user expresses EITHER a point time (e.g. 19:00 →
 * implies the ±1h default band) OR an explicit RANGE (e.g. 07:00–09:00).
 * The editor shows the resulting on-time band plus a cadence-aware
 * "verspätet bis …" hint derived from the engine's late tail. It is a
 * controlled component over the persisted `DoseWindowEntry[]` contract
 * (`{ timeOfDay, start, end }`), validated client-side to match the W7
 * zod: HH:mm, `start <= end`, `timeOfDay ∈ timesOfDay`.
 *
 * Calm, inset-grouped, AA. No card tint — the surface follows the muted
 * section chrome the other Zeitplan / Erinnerung rows use.
 */

import { useCallback, useId, useMemo } from "react";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/lib/i18n/context";
import {
  buildRows,
  defaultBandForTime,
  isOrderedRange,
  isValidHhmm,
  lateTailDays,
  lateTailEndHhmm,
  rowsToEntries,
  type DoseWindowEntry,
  type DoseWindowRow,
  type DoseWindowScale,
} from "./dose-window";

export interface DoseWindowEditorProps {
  /** The schedule's dose times (HH:mm) — one editor row per time. */
  timesOfDay: string[];
  /** The persisted explicit windows for this schedule. */
  value: DoseWindowEntry[];
  /** Emits the next explicit-window set (point-equivalent rows dropped). */
  onChange: (next: DoseWindowEntry[]) => void;
  /**
   * Cadence scale — drives the late-tail hint. `intraday` (daily /
   * multi-daily) shows a wall-clock late end; `dayScale` (weekly /
   * rolling) shows the day-count tail. Defaults to `intraday`.
   */
  scale?: DoseWindowScale;
  /** Disables every control (e.g. while a save is in flight). */
  disabled?: boolean;
  /** Stable id-prefix for the rendered inputs (defaults to a generated id). */
  idPrefix?: string;
}

export function DoseWindowEditor({
  timesOfDay,
  value,
  onChange,
  scale = "intraday",
  disabled = false,
  idPrefix,
}: DoseWindowEditorProps) {
  const { t } = useTranslations();
  const generatedId = useId();
  const prefix = idPrefix ?? generatedId;

  const rows = useMemo(() => buildRows(timesOfDay, value), [timesOfDay, value]);

  // Rebuild the persisted set from the next row state and bubble it up.
  const emit = useCallback(
    (nextRows: DoseWindowRow[]) => {
      onChange(rowsToEntries(nextRows));
    },
    [onChange],
  );

  const setRow = useCallback(
    (timeOfDay: string, patch: Partial<DoseWindowRow>) => {
      emit(
        rows.map((r) => (r.timeOfDay === timeOfDay ? { ...r, ...patch } : r)),
      );
    },
    [emit, rows],
  );

  const toggleCustom = useCallback(
    (row: DoseWindowRow, custom: boolean) => {
      if (custom) {
        // Switching ON seeds the range from the current default band so
        // the user starts from the same band the engine would derive.
        const def = defaultBandForTime(row.timeOfDay);
        setRow(row.timeOfDay, { custom: true, start: def.start, end: def.end });
      } else {
        setRow(row.timeOfDay, { custom: false });
      }
    },
    [setRow],
  );

  if (rows.length === 0) {
    return (
      <p
        className="text-muted-foreground text-sm"
        data-slot="dose-window-editor-empty"
      >
        {t("medications.detail.zeitplan.window.noTimes")}
      </p>
    );
  }

  return (
    <div className="space-y-3" data-slot="dose-window-editor">
      <p className="text-muted-foreground text-xs">
        {t("medications.detail.zeitplan.window.intro")}
      </p>
      <ul className="divide-border divide-y rounded-md border" role="list">
        {rows.map((row) => {
          const ordered = isOrderedRange(row.start, row.end);
          const lateEnd = lateTailEndHhmm(row.end, scale);
          const switchId = `${prefix}-custom-${row.timeOfDay}`;
          const startId = `${prefix}-start-${row.timeOfDay}`;
          const endId = `${prefix}-end-${row.timeOfDay}`;
          return (
            <li
              key={row.timeOfDay}
              className="space-y-2 p-3"
              data-slot="dose-window-row"
              data-time={row.timeOfDay}
              data-custom={row.custom ? "true" : "false"}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-foreground text-sm font-medium tabular-nums">
                  {row.timeOfDay}
                </span>
                <div className="flex items-center gap-2">
                  <Label
                    htmlFor={switchId}
                    className="text-muted-foreground text-xs"
                  >
                    {t("medications.detail.zeitplan.window.explicitToggle")}
                  </Label>
                  <Switch
                    id={switchId}
                    checked={row.custom}
                    disabled={disabled}
                    onCheckedChange={(checked) => toggleCustom(row, checked)}
                    data-slot="dose-window-explicit-switch"
                  />
                </div>
              </div>

              {row.custom ? (
                <div className="space-y-2" data-slot="dose-window-range">
                  <div className="flex flex-wrap items-center gap-2">
                    <Label htmlFor={startId} className="sr-only">
                      {t("medications.detail.zeitplan.window.startLabel")}
                    </Label>
                    <Input
                      id={startId}
                      type="time"
                      value={row.start}
                      disabled={disabled}
                      onChange={(e) =>
                        setRow(row.timeOfDay, { start: e.target.value })
                      }
                      className="h-11 w-32 sm:h-9"
                      aria-label={t(
                        "medications.detail.zeitplan.window.startLabel",
                      )}
                      data-slot="dose-window-start"
                    />
                    <span className="text-muted-foreground text-sm">–</span>
                    <Label htmlFor={endId} className="sr-only">
                      {t("medications.detail.zeitplan.window.endLabel")}
                    </Label>
                    <Input
                      id={endId}
                      type="time"
                      value={row.end}
                      disabled={disabled}
                      onChange={(e) =>
                        setRow(row.timeOfDay, { end: e.target.value })
                      }
                      className="h-11 w-32 sm:h-9"
                      aria-label={t(
                        "medications.detail.zeitplan.window.endLabel",
                      )}
                      data-slot="dose-window-end"
                    />
                  </div>
                  {isValidHhmm(row.start) &&
                  isValidHhmm(row.end) &&
                  !ordered ? (
                    <p
                      className="text-destructive text-sm"
                      role="alert"
                      data-slot="dose-window-error"
                    >
                      {t("medications.detail.zeitplan.window.orderError")}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {/* The resulting on-time band + the late tail. Always shown so
                  the point case still communicates its implied ±1h band. */}
              <p
                className="text-muted-foreground text-xs"
                data-slot="dose-window-band"
              >
                {t("medications.detail.zeitplan.window.onTimeBand", {
                  start: row.start,
                  end: row.end,
                })}
                {scale === "dayScale"
                  ? ` · ${t("medications.detail.zeitplan.window.lateDays", {
                      days: lateTailDays(),
                    })}`
                  : lateEnd
                    ? ` · ${t("medications.detail.zeitplan.window.lateUntil", {
                        time: lateEnd,
                      })}`
                    : ""}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
