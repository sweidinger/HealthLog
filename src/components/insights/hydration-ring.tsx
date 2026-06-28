"use client";

import { useEffect, useId, useState } from "react";

import { cn } from "@/lib/utils";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";

/**
 * v1.25 — hydration daily-goal ring.
 *
 * A hand-rolled SVG arc gauge in the same idiom as `score-ring.tsx` (fixed
 * `0 0 100 100` viewBox, ~9% round-cap stroke, a faint same-hue track, a
 * subtle first-paint sweep gated on `prefers-reduced-motion`). It is purpose-
 * built for a goal counter rather than a 0–100 band score: the arc fills to the
 * percent of goal (capped at 100), the centre shows the day's total in ml, and
 * the hue is a single calm water tone — never the green/yellow/red band
 * semantics a low score would otherwise paint, so "not much yet" never reads as
 * an alarm. The `<linearGradient>` is real SVG JSX, not innerHTML.
 */

const VIEW = 100;
const STROKE = 9;
const R = (VIEW - STROKE) / 2;
const C = 2 * Math.PI * R;
const CX = VIEW / 2;

export interface HydrationRingProps {
  /** Progress toward the goal, 0..100 (already capped by the caller). */
  percent: number;
  /** Today's total in ml — the centred number. */
  totalMl: number;
  /** The goal in ml — rendered under the total. */
  goalMl: number;
  /** Whether the goal has been met (adds a met affordance). */
  met?: boolean;
  /** Render size in px. */
  size?: number;
  className?: string;
}

export function HydrationRing({
  percent,
  totalMl,
  goalMl,
  met = false,
  size = 168,
  className,
}: HydrationRingProps) {
  const gid = useId();
  const clamped = Math.min(
    100,
    Math.max(0, Number.isFinite(percent) ? percent : 0),
  );
  const dash = (clamped / 100) * C;

  const reduced = prefersReducedMotion();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (reduced) return;
    const raf = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(raf);
  }, [reduced]);
  const filled = reduced || armed;

  return (
    <div
      data-slot="hydration-ring"
      data-met={met ? "true" : undefined}
      role="img"
      aria-label={`${totalMl} of ${goalMl} ml (${Math.round(clamped)}%)`}
      className={cn("relative shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <svg
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        className="h-full w-full -rotate-90"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--chart-2)" />
            <stop offset="100%" stopColor="var(--chart-2)" />
          </linearGradient>
        </defs>
        {/* Faint full-circle track. */}
        <circle
          cx={CX}
          cy={CX}
          r={R}
          fill="none"
          stroke={`url(#${gid})`}
          strokeOpacity={0.16}
          strokeWidth={STROKE}
        />
        {/* Progress arc — round cap, subtle first-paint sweep. */}
        <circle
          cx={CX}
          cy={CX}
          r={R}
          fill="none"
          stroke={`url(#${gid})`}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={C}
          style={{
            strokeDashoffset: filled ? C - dash : C,
            transition: reduced
              ? undefined
              : "stroke-dashoffset 900ms var(--ring-ease, ease-out)",
          }}
        />
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-foreground text-3xl font-semibold tracking-tight tabular-nums">
          {totalMl}
        </span>
        <span className="text-muted-foreground text-[11px]">{`/ ${goalMl} ml`}</span>
      </div>
    </div>
  );
}
