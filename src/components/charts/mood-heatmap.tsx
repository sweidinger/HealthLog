"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { useTranslations } from "@/lib/i18n/context";
import { moodLabelKeyForScore } from "@/lib/mood/labels";

/**
 * v1.8.5 — mood calendar heatmap.
 *
 * Forked from `compliance-heatmap.tsx`: same SVG cell-grid, Monday-aligned
 * columns, month markers, tap-to-pin tooltip, and `stretch` adaptive cell
 * sizing. The one swap is `getColor` — instead of an expected/taken
 * compliance map, each cell is coloured by its daily-mean mood score band
 * (matching the `mood-chart.tsx` VALUE_BANDS: 1–2 red, 2–3 orange, 3–5
 * green). One cell per calendar day; days with no entry render in the
 * neutral `--secondary` fill.
 */

interface MoodHeatmapCell {
  /** YYYY-MM-DD day key. */
  date: string;
  /** Daily-mean mood score 1..5. */
  score: number;
  /** Number of entries that fed the mean. */
  samples: number;
}

interface MoodHeatmapProps {
  /** Per-day cells keyed by YYYY-MM-DD. */
  cells: Record<string, MoodHeatmapCell>;
  days?: number;
  stretch?: boolean;
}

const CELL_SIZE = 18;
const GAP = 3;
const CELL_FLOOR_PX = 14;
// v1.15.3 — cell-ceiling for the stretch branch. A short window (few covered
// weeks → only ~5 columns) drove the adaptive `containerWidth / weeks` cell to
// fill a wide card; since the grid is square the SVG height blew up to ~3× the
// neighbouring tiles. Capping the cell keeps the grid dense + left-aligned so
// the calendar holds the tile-height rhythm. Mirrors `compliance-heatmap.tsx`.
const CELL_CEIL_PX = 22;

/**
 * Mood score band → Dracula colour. Mirrors `mood-chart.tsx` VALUE_BANDS
 * (1–2 red, 2–3 orange, 3–5 green) and the green/orange thresholds in
 * `mood-aggregates.ts`. No score (no entry that day) → neutral fill.
 */
function getColor(score: number | null): string {
  if (score == null) return "var(--secondary)";
  if (score < 2) return "var(--dracula-red)";
  if (score < 3) return "var(--dracula-orange)";
  if (score < 3.5) return "var(--dracula-yellow)";
  return "var(--dracula-green)";
}

function formatDateDE(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  return `${d.getUTCDate()}.${d.getUTCMonth() + 1}.${d.getUTCFullYear()}`;
}

export function MoodHeatmap({
  cells: cellData,
  days = 90,
  stretch = false,
}: MoodHeatmapProps) {
  const { t } = useTranslations();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    text: string;
    pinned?: boolean;
  } | null>(null);

  useEffect(() => {
    if (!tooltip?.pinned) return;
    const handlePointer = (event: PointerEvent) => {
      const container = containerRef.current;
      if (!container) return;
      if (!container.contains(event.target as Node)) {
        setTooltip(null);
      }
    };
    document.addEventListener("pointerdown", handlePointer, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointer, true);
    };
  }, [tooltip?.pinned]);

  const WEEKDAY_LABELS = [
    t("charts.weekdays.mon"),
    "",
    t("charts.weekdays.wed"),
    "",
    t("charts.weekdays.fri"),
    "",
    t("charts.weekdays.sun"),
  ];

  useEffect(() => {
    if (!stretch) return;
    const element = containerRef.current;
    if (!element) return;

    const updateWidth = () => {
      setContainerWidth(element.clientWidth);
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [stretch]);

  const { cells, weeks, monthMarkers } = useMemo(() => {
    const MONTH_LABELS = [
      t("charts.months.jan"),
      t("charts.months.feb"),
      t("charts.months.mar"),
      t("charts.months.apr"),
      t("charts.months.may"),
      t("charts.months.jun"),
      t("charts.months.jul"),
      t("charts.months.aug"),
      t("charts.months.sep"),
      t("charts.months.oct"),
      t("charts.months.nov"),
      t("charts.months.dec"),
    ];
    const now = new Date();
    const cellList: Array<{
      dateKey: string;
      col: number;
      row: number;
      color: string;
      cell: MoodHeatmapCell | null;
    }> = [];

    const dates: Date[] = [];
    for (let d = days - 1; d >= 0; d--) {
      const date = new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
      dates.push(date);
    }

    // Monday-align + month markers read off the UTC accessors so the
    // grid matches the UTC-anchored dateKey (mirrors compliance-heatmap).
    const firstDate = dates[0];
    const firstDow = (firstDate.getUTCDay() + 6) % 7; // Monday = 0

    let col = 0;
    const markers: Array<{ col: number; label: string }> = [];
    let lastMonth = -1;

    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      const dow = (date.getUTCDay() + 6) % 7; // Monday = 0
      const currentCol = Math.floor((i + firstDow) / 7);
      const row = dow;
      const dateKey = date.toISOString().slice(0, 10);
      const cell = cellData[dateKey] ?? null;

      const month = date.getUTCMonth();
      if (month !== lastMonth) {
        markers.push({ col: currentCol, label: MONTH_LABELS[month] });
        lastMonth = month;
      }

      cellList.push({
        dateKey,
        col: currentCol,
        row,
        color: getColor(cell?.score ?? null),
        cell,
      });

      col = Math.max(col, currentCol);
    }

    return { cells: cellList, weeks: col + 1, monthMarkers: markers };
  }, [cellData, days, t]);

  const labelWidth = stretch ? 0 : 76;
  const headerHeight = 18;
  const cellSize =
    stretch && containerWidth > 0
      ? Math.min(
          CELL_CEIL_PX,
          Math.max(
            CELL_FLOOR_PX,
            (containerWidth - labelWidth - Math.max(0, weeks - 1) * GAP) /
              Math.max(weeks, 1),
          ),
        )
      : CELL_SIZE;
  const step = cellSize + GAP;
  const svgWidth = labelWidth + weeks * cellSize + Math.max(0, weeks - 1) * GAP;
  const svgHeight = headerHeight + 7 * cellSize + 6 * GAP;

  return (
    <div className={`relative ${stretch ? "w-full" : ""}`} ref={containerRef}>
      <div
        className={
          stretch
            ? "w-full overflow-x-auto sm:w-full sm:overflow-visible"
            : "overflow-x-auto"
        }
      >
        <svg
          width={svgWidth}
          height={svgHeight}
          // v1.15.3 — `max-w-full` (not `w-full`) so a short window keeps its
          // natural, square, left-aligned grid rather than CSS-stretching a few
          // capped columns into wide rectangles. Mirrors `compliance-heatmap`.
          className={stretch ? "block max-w-full" : "block"}
          onMouseLeave={() =>
            setTooltip((prev) => (prev?.pinned ? prev : null))
          }
        >
          {monthMarkers.map((m, i) => (
            <text
              key={i}
              x={labelWidth + m.col * step}
              y={11}
              className="fill-muted-foreground"
              fontSize={10}
            >
              {m.label}
            </text>
          ))}

          {!stretch &&
            WEEKDAY_LABELS.map(
              (label, i) =>
                label && (
                  <text
                    key={i}
                    x={labelWidth - 6}
                    y={headerHeight + i * step + cellSize * 0.65}
                    textAnchor="end"
                    className="fill-muted-foreground"
                    fontSize={10}
                  >
                    {label}
                  </text>
                ),
            )}

          {cells.map((cell) => {
            const buildText = (): string => {
              if (!cell.cell) {
                return `${formatDateDE(cell.dateKey)}: ${t("insights.mood.heatmapNoEntry")}`;
              }
              const labelKey = moodLabelKeyForScore(
                Math.round(cell.cell.score),
              );
              const moodLabel = labelKey ? t(labelKey) : "";
              return `${formatDateDE(cell.dateKey)}: ${cell.cell.score.toFixed(1)}${moodLabel ? ` · ${moodLabel}` : ""}`;
            };
            return (
              <rect
                key={cell.dateKey}
                x={labelWidth + cell.col * step}
                y={headerHeight + cell.row * step}
                width={cellSize}
                height={cellSize}
                rx={2}
                fill={cell.color}
                // v1.19.1 — populated days render at full saturation so the
                // mood band reads clearly; only the no-entry cells stay the
                // quiet `--secondary` empty-state tint.
                fillOpacity={1}
                className="cursor-pointer"
                onPointerEnter={(e) => {
                  if (e.pointerType === "touch") return;
                  setTooltip({
                    x: e.clientX,
                    y: e.clientY,
                    text: buildText(),
                  });
                }}
                onPointerLeave={(e) => {
                  if (e.pointerType === "touch") return;
                  setTooltip((prev) => (prev?.pinned ? prev : null));
                }}
                onPointerDown={(e) => {
                  if (e.pointerType !== "touch") return;
                  setTooltip({
                    x: e.clientX,
                    y: e.clientY,
                    text: buildText(),
                    pinned: true,
                  });
                }}
              />
            );
          })}
        </svg>
      </div>

      {tooltip && (
        <div
          className="bg-popover text-popover-foreground border-border pointer-events-none fixed z-50 rounded-md border px-2 py-1 text-xs shadow-md"
          style={{ left: tooltip.x + 10, top: tooltip.y - 30 }}
        >
          {tooltip.text}
        </div>
      )}

      <div
        className="text-muted-foreground mt-2 flex flex-wrap items-center gap-3 text-xs"
        style={{ marginLeft: stretch ? 0 : labelWidth }}
      >
        {[
          {
            color: "var(--dracula-green)",
            label: t("insights.mood.legendGreat"),
          },
          {
            color: "var(--dracula-yellow)",
            label: t("insights.mood.legendGood"),
          },
          {
            color: "var(--dracula-orange)",
            label: t("insights.mood.legendOkay"),
          },
          { color: "var(--dracula-red)", label: t("insights.mood.legendLow") },
        ].map(({ color, label }) => (
          <span key={label} className="flex items-center gap-1">
            <div
              className="h-3 w-3 rounded-sm"
              style={{ backgroundColor: color }}
            />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
