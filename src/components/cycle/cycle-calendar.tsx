"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import type { CalendarDay } from "./types";
import { FERTILE_HUE, FLOW_HUE, OVULATION_HUE } from "./phase-tokens";

/**
 * v1.15.0 — the month calendar.
 *
 * Renders one month at a time over the calendar read's day grid. Logged
 * period days carry a filled rose pip; the predicted next period renders as
 * a ranged BAND (a soft rose underline spanning the predicted days, never a
 * single dated dot); the fertile window (already goal-gated server-side — the
 * API nulls it unless TRYING_TO_CONCEIVE) renders as a green ring; the
 * predicted-ovulation day gets an amber marker; per-day symptom presence
 * shows a small dot. Selecting a day calls `onSelectDay` (the log-day sheet).
 *
 * a11y: each day is a real `<button>` with an aria-label restating the date
 * + its markers; the colour markers are paired with the aria text so the
 * grid is never colour-only. WCAG 2.5.5 — each cell is ≥ 40 px.
 */

/** Monday-first short weekday labels, localized via Intl (no i18n key). */
function shortWeekdays(): string[] {
  const fmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  // 2024-01-01 is a Monday — walk 7 days for a Monday-first header row.
  return Array.from({ length: 7 }, (_, i) =>
    fmt.format(new Date(2024, 0, 1 + i)),
  );
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** 0=Mon … 6=Sun (Monday-first grid). */
function mondayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

export interface CycleCalendarProps {
  days: CalendarDay[];
  /** YYYY-MM-DD of today (server tz-anchored) for the "today" ring. */
  today: string;
  onSelectDay: (date: string) => void;
  className?: string;
}

export function CycleCalendar({
  days,
  today,
  onSelectDay,
  className,
}: CycleCalendarProps) {
  const { t } = useTranslations();
  const weekdays = useMemo(() => shortWeekdays(), []);
  const byDate = useMemo(
    () => new Map(days.map((d) => [d.date, d])),
    [days],
  );

  // Anchor the visible month on today's month.
  const [monthAnchor, setMonthAnchor] = useState(() => {
    const [y, m] = today.split("-").map(Number);
    return new Date(y, m - 1, 1);
  });

  const grid = useMemo(() => {
    const first = new Date(
      monthAnchor.getFullYear(),
      monthAnchor.getMonth(),
      1,
    );
    const lead = mondayIndex(first);
    const daysInMonth = new Date(
      monthAnchor.getFullYear(),
      monthAnchor.getMonth() + 1,
      0,
    ).getDate();
    const cells: (Date | null)[] = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let day = 1; day <= daysInMonth; day++) {
      cells.push(
        new Date(monthAnchor.getFullYear(), monthAnchor.getMonth(), day),
      );
    }
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [monthAnchor]);

  const monthLabel = monthAnchor.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  function shiftMonth(delta: number) {
    setMonthAnchor(
      (a) => new Date(a.getFullYear(), a.getMonth() + delta, 1),
    );
  }

  return (
    <div data-slot="cycle-calendar" className={cn("space-y-3", className)}>
      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("cycle.calendar.prevMonth")}
          onClick={() => shiftMonth(-1)}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-sm font-semibold capitalize">{monthLabel}</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("cycle.calendar.nextMonth")}
          onClick={() => shiftMonth(1)}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      <div
        role="grid"
        aria-label={monthLabel}
        className="grid grid-cols-7 gap-1"
      >
        {weekdays.map((wk, i) => (
          <div
            key={i}
            role="columnheader"
            className="text-muted-foreground pb-1 text-center text-[11px] font-medium uppercase"
          >
            {wk}
          </div>
        ))}

        {grid.map((cell, i) => {
          if (!cell) return <div key={`empty-${i}`} aria-hidden="true" />;
          const date = ymd(cell);
          const info = byDate.get(date);
          const isToday = date === today;
          const markers: string[] = [];
          if (info?.isPeriodLogged) markers.push(t("cycle.calendar.legendPeriod"));
          if (info?.isPredictedPeriod)
            markers.push(t("cycle.calendar.legendPredicted"));
          if (info?.isFertileWindow)
            markers.push(t("cycle.calendar.legendFertile"));
          if (info?.isPredictedOvulation)
            markers.push(t("cycle.calendar.legendOvulation"));
          if (info?.hasSymptoms)
            markers.push(t("cycle.calendar.legendSymptoms"));

          const aria = `${date}${markers.length ? `, ${markers.join(", ")}` : ""}`;

          return (
            <button
              key={date}
              type="button"
              role="gridcell"
              aria-label={aria}
              aria-current={isToday ? "date" : undefined}
              onClick={() => onSelectDay(date)}
              className={cn(
                "relative flex aspect-square min-h-10 flex-col items-center justify-center rounded-lg text-sm transition-colors",
                "hover:bg-accent focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-2",
                info?.isFertileWindow && "ring-1 ring-inset",
                isToday && "font-semibold",
              )}
              style={
                info?.isFertileWindow
                  ? ({ "--tw-ring-color": FERTILE_HUE } as React.CSSProperties)
                  : undefined
              }
            >
              {/* Logged-period filled pip behind the number. */}
              {info?.isPeriodLogged ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-1 rounded-md opacity-20"
                  style={{ backgroundColor: FLOW_HUE }}
                />
              ) : null}
              <span
                className={cn(
                  "relative z-10",
                  isToday && "text-primary",
                )}
              >
                {cell.getDate()}
              </span>

              {/* Predicted-period band: a soft underline, never a dot. */}
              {info?.isPredictedPeriod && !info?.isPeriodLogged ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-1.5 bottom-1 h-0.5 rounded-full opacity-70"
                  style={{
                    backgroundColor: FLOW_HUE,
                    backgroundImage: `repeating-linear-gradient(90deg, ${FLOW_HUE} 0 3px, transparent 3px 5px)`,
                  }}
                />
              ) : null}

              {/* Marker row: ovulation + symptom dots. */}
              <span
                aria-hidden="true"
                className="relative z-10 mt-0.5 flex h-1.5 items-center gap-0.5"
              >
                {info?.isPredictedOvulation ? (
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: OVULATION_HUE }}
                  />
                ) : null}
                {info?.hasSymptoms ? (
                  <span className="bg-muted-foreground/70 h-1 w-1 rounded-full" />
                ) : null}
              </span>
            </button>
          );
        })}
      </div>

      <CalendarLegend />
    </div>
  );
}

function CalendarLegend() {
  const { t } = useTranslations();
  const items: { hue: string; labelKey: string; dashed?: boolean }[] = [
    { hue: FLOW_HUE, labelKey: "cycle.calendar.legendPeriod" },
    { hue: FLOW_HUE, labelKey: "cycle.calendar.legendPredicted", dashed: true },
    { hue: FERTILE_HUE, labelKey: "cycle.calendar.legendFertile" },
    { hue: OVULATION_HUE, labelKey: "cycle.calendar.legendOvulation" },
  ];
  return (
    <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
      {items.map((it) => (
        <li key={it.labelKey} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn("h-2.5 w-2.5 rounded-full", it.dashed && "opacity-60")}
            style={{ backgroundColor: it.hue }}
          />
          {t(it.labelKey)}
        </li>
      ))}
    </ul>
  );
}
