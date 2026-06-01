"use client";

import { useEffect, useRef, useState } from "react";
import { Flame } from "lucide-react";

import { useFormatters, useTranslations } from "@/lib/i18n/context";

/**
 * v1.8.5 — uptime-style per-dose adherence strip for sparse cadences.
 *
 * The medication cards keep the 7-/30-day percentage bars for dense
 * cadences (daily / multi-daily / weekday meds) where the denominator is
 * large enough for the percentage to be stable. For sparse cadences
 * (weekly, bi-/tri-weekly, rolling 35-day injections) a rolling percentage
 * swings violently off one sample and tells the user nothing; the server
 * flips `complianceDisplay.mode` to `"timeline"` and this strip takes over.
 *
 * Each cell is one EXPECTED dose (not a calendar day), oldest → newest:
 * taken=green / missed=red / skipped=grey / upcoming=outline. The color
 * tokens and the tap-to-pin tooltip mirror the 90-day compliance heatmap
 * (`src/components/charts/compliance-heatmap.tsx`) so the two surfaces read
 * the same. Plain flex divs, not Recharts — a fixed-size status-cell row
 * needs no chart container, axis, or tooltip plumbing.
 */

export type DoseStatus = "taken" | "missed" | "skipped" | "upcoming";
export type DoseTiming = "early" | "on_time" | "late" | "very_late" | "missed";

export interface DoseAdherenceCell {
  scheduledFor: string;
  status: DoseStatus;
  takenAt: string | null;
  timing: DoseTiming | null;
  site: string | null;
}

interface DoseAdherenceTimelineProps {
  doses: DoseAdherenceCell[];
  summary: { taken: number; total: number; doseStreak: number };
}

// v1.4.27 MB7 / CF-10 precedent — clear the 14 px touch floor (with the
// gap the row stays tap-friendly on narrow viewports). Mirrors the
// heatmap's `CELL_FLOOR_PX`.
const CELL_PX = 14;

/** Token mirror of the heatmap's status palette. */
function cellColor(status: DoseStatus, timing: DoseTiming | null): string {
  if (status === "upcoming") return "transparent";
  if (status === "skipped") return "var(--secondary)";
  if (status === "missed") return "var(--dracula-red)";
  // taken — shade by punctuality, same ladder the heatmap uses.
  if (timing === "very_late") return "var(--dracula-orange)";
  if (timing === "late") return "var(--dracula-yellow)";
  return "var(--dracula-green)";
}

export function DoseAdherenceTimeline({
  doses,
  summary,
}: DoseAdherenceTimelineProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    text: string;
    pinned?: boolean;
  } | null>(null);

  // Mirror the heatmap: an outside tap clears a pinned tooltip so a touch
  // user can dismiss the per-cell detail. Gated on `pinned` so the hover
  // flow never pays the indirection.
  useEffect(() => {
    if (!tooltip?.pinned) return;
    const handlePointer = (event: PointerEvent) => {
      const container = containerRef.current;
      if (!container) return;
      if (!container.contains(event.target as Node)) setTooltip(null);
    };
    document.addEventListener("pointerdown", handlePointer, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointer, true);
    };
  }, [tooltip?.pinned]);

  function statusLabel(status: DoseStatus): string {
    if (status === "taken") return t("medications.doseTaken");
    if (status === "missed") return t("medications.doseMissed");
    if (status === "skipped") return t("medications.doseSkipped");
    return t("medications.doseUpcoming");
  }

  function cellText(cell: DoseAdherenceCell): string {
    const when = fmt.dateTime(cell.scheduledFor);
    return `${when} — ${statusLabel(cell.status)}`;
  }

  return (
    <div className="space-y-2" ref={containerRef}>
      <div className="relative">
        <div
          className="flex flex-wrap gap-1"
          role="img"
          aria-label={t("medications.doseTimelineAriaLabel")}
        >
          {doses.map((cell, i) => {
            const isUpcoming = cell.status === "upcoming";
            return (
              <div
                key={`${cell.scheduledFor}-${i}`}
                className={`shrink-0 cursor-pointer rounded-sm ${
                  isUpcoming ? "border-border border border-dashed" : ""
                }`}
                style={{
                  width: CELL_PX,
                  height: CELL_PX,
                  backgroundColor: cellColor(cell.status, cell.timing),
                }}
                onPointerEnter={(e) => {
                  if (e.pointerType === "touch") return;
                  setTooltip({
                    x: e.clientX,
                    y: e.clientY,
                    text: cellText(cell),
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
                    text: cellText(cell),
                    pinned: true,
                  });
                }}
              />
            );
          })}
        </div>

        {tooltip && (
          <div
            className="bg-popover text-popover-foreground border-border pointer-events-none fixed z-50 rounded-md border px-2 py-1 text-xs shadow-md"
            style={{ left: tooltip.x + 10, top: tooltip.y - 30 }}
          >
            {tooltip.text}
          </div>
        )}
      </div>

      <div className="text-muted-foreground flex items-center gap-3 text-xs">
        <span>
          {t("medications.lastNDoses", {
            total: summary.total,
            taken: summary.taken,
          })}
        </span>
        {summary.doseStreak > 0 && (
          <span className="text-dracula-orange flex items-center gap-1 font-medium">
            <Flame className="h-3.5 w-3.5" />
            {t("medications.doseStreak", { count: summary.doseStreak })}
          </span>
        )}
      </div>
    </div>
  );
}
