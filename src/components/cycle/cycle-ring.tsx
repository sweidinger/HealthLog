"use client";

import { useMemo } from "react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import type { CyclePhase } from "./types";
import { PHASE_HUE } from "./phase-tokens";

/**
 * v1.15.0 — the cycle wheel: a hand-rolled SVG phase ring (0 KB runtime, no
 * chart lib), matching the premium wellness-ring aesthetic (calm distinct
 * hues, thin round-cap arcs, a faint segmented track). Unlike the 0–100
 * score gauge this is a FULL-circle dial: the four cycle phases render as
 * proportional arc segments around the ring, and a marker dot sits at the
 * current day-of-cycle. The day number is real centred DOM text.
 *
 * a11y: `role="img"` + a phase-aware aria-label so the ring is never
 * colour-only. The marker + segments are JSX SVG (`<linearGradient>` is NOT
 * `dangerouslySetInnerHTML`).
 */

const VIEW = 100;
const STROKE = 8;
const R = (VIEW - STROKE) / 2;
const C = 2 * Math.PI * R;
const CX = VIEW / 2;
const GAP = 0.5; // unit gap between segments so phases read as distinct arcs.

const PHASE_ORDER: CyclePhase[] = [
  "MENSTRUAL",
  "FOLLICULAR",
  "OVULATORY",
  "LUTEAL",
];

export interface PhaseSpan {
  phase: CyclePhase;
  /** Proportion of the cycle this phase covers (0..1). Spans sum to ~1. */
  fraction: number;
}

export interface CycleRingProps {
  /** 1-based day of the current cycle, or null when no cycle is active. */
  dayOfCycle: number | null;
  /** Total length the ring represents (estimated cycle length, days). */
  cycleLength: number | null;
  /** The current phase (drives the centre label + aria). */
  phase: CyclePhase | null;
  /** Proportional phase spans around the ring. Omit for an even quarter split. */
  spans?: PhaseSpan[];
  size?: number;
  className?: string;
}

function evenSpans(): PhaseSpan[] {
  return PHASE_ORDER.map((phase) => ({ phase, fraction: 0.25 }));
}

export function CycleRing({
  dayOfCycle,
  cycleLength,
  phase,
  spans,
  size = 220,
  className,
}: CycleRingProps) {
  const { t } = useTranslations();
  const reduced = prefersReducedMotion();

  const resolvedSpans = useMemo(() => {
    const raw = spans && spans.length > 0 ? spans : evenSpans();
    const total = raw.reduce((s, x) => s + x.fraction, 0) || 1;
    return raw.map((x) => ({ ...x, fraction: x.fraction / total }));
  }, [spans]);

  // Build each phase arc as a dash segment around the ring. The running
  // start-offset is carried through `reduce` rather than mutating a closure
  // variable inside `map` (the latter trips the render-immutability rule).
  const segments = useMemo(
    () =>
      resolvedSpans.reduce<
        {
          offset: number;
          segs: {
            phase: CyclePhase;
            dashArray: string;
            dashOffset: number;
            active: boolean;
          }[];
        }
      >(
        (acc, span) => {
          const len = Math.max(span.fraction * C - GAP, 0);
          acc.segs.push({
            phase: span.phase,
            dashArray: `${len} ${C - len}`,
            dashOffset: -acc.offset,
            active: span.phase === phase,
          });
          return {
            offset: acc.offset + span.fraction * C,
            segs: acc.segs,
          };
        },
        { offset: 0, segs: [] },
      ).segs,
    [resolvedSpans, phase],
  );

  // The marker sits at the cycle-day proportion around the circle.
  const markerProgress =
    dayOfCycle != null && cycleLength != null && cycleLength > 0
      ? Math.min(dayOfCycle / cycleLength, 1)
      : null;
  const markerAngle =
    markerProgress != null ? markerProgress * 2 * Math.PI - Math.PI / 2 : null;
  const markerX = markerAngle != null ? CX + R * Math.cos(markerAngle) : 0;
  const markerY = markerAngle != null ? CX + R * Math.sin(markerAngle) : 0;

  const phaseLabel = phase
    ? t(`cycle.phase.${phase}`)
    : t("cycle.phase.none");

  const ariaLabel =
    dayOfCycle != null
      ? t("cycle.ring.ariaPhase", { day: dayOfCycle, phase: phaseLabel })
      : t("cycle.ring.ariaUnknown");

  return (
    <div
      data-slot="cycle-ring"
      data-phase={phase ?? "none"}
      role="img"
      aria-label={ariaLabel}
      className={cn("relative shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <svg
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        className="h-full w-full -rotate-90"
        aria-hidden="true"
      >
        {/* Faint segmented tick track — reads as an instrument. */}
        <circle
          cx={CX}
          cy={CX}
          r={R}
          fill="none"
          stroke="var(--muted-foreground)"
          strokeOpacity={0.12}
          strokeWidth={STROKE}
          strokeDasharray="0.5 4.2"
        />
        {/* Phase arcs — one calm hue per phase, the active phase fully opaque. */}
        {segments.map((seg) => (
          <circle
            key={seg.phase}
            cx={CX}
            cy={CX}
            r={R}
            fill="none"
            stroke={PHASE_HUE[seg.phase]}
            strokeOpacity={seg.active ? 1 : 0.32}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={seg.dashArray}
            strokeDashoffset={seg.dashOffset}
            style={{
              transition: reduced ? undefined : "stroke-opacity 400ms ease",
            }}
          />
        ))}
        {/* Current-day marker dot. */}
        {markerAngle != null ? (
          <circle
            cx={markerX}
            cy={markerY}
            r={STROKE / 1.7}
            fill="var(--background)"
            stroke={phase ? PHASE_HUE[phase] : "var(--foreground)"}
            strokeWidth={2}
          />
        ) : null}
      </svg>
      {/* Centred day number + phase caption as real DOM text. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="text-foreground text-4xl font-semibold tracking-tight tabular-nums">
          {dayOfCycle != null ? dayOfCycle : t("cycle.ring.dayUnknown")}
        </span>
        <span className="text-muted-foreground mt-0.5 text-xs">
          {phaseLabel}
        </span>
      </div>
    </div>
  );
}
