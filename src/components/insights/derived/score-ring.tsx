"use client";

import { useId } from "react";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { useCountUp } from "@/hooks/use-count-up";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { bandForScore, clampScore, type ScoreBand } from "./band-tokens";
import { RING_GRADIENT, type RingHue } from "./ring-hues";

/**
 * v1.13.x — the composite-score dial, now a hand-rolled SVG arc gauge
 * (Recharts retired FROM THIS COMPONENT ONLY; it stays the default for real
 * data charts elsewhere). A score dial is a fixed-geometry gauge, not a data
 * chart, so a ~40-LOC SVG gives exact control over a thin round-cap arc, a
 * faint same-hue track, and a single-hue two-stop gradient — the premium
 * Apple/Oura signature — at 0 KB runtime and with no per-tile resize
 * observer.
 *
 * The arc is a single `<circle stroke-dasharray>` swept by `stroke-dashoffset`,
 * filled with a JSX `<linearGradient>` (NOT a `dangerouslySetInnerHTML` —
 * `<defs>`/`<linearGradient>` are real SVG JSX). The `<svg>` is rotated -90°
 * so the arc starts at 12 o'clock and sweeps clockwise without per-point trig.
 * The centred number is real DOM text (not SVG `<text>`), so a long label can
 * never clip under the SVG viewbox and the number uses the design tokens.
 *
 * `score === null` renders the provisional/empty state: an unfilled ring with
 * an em-dash and a localised "not enough data yet" caption.
 *
 * a11y: `role="img"` + an aria-label restating the number + band, so the ring
 * is never colour-only. `prefers-reduced-motion` paints the final arc offset
 * with no transition and disables the count-up.
 *
 * `hue` selects a per-metric single-hue gradient (readiness greener, sleep
 * bluer, recovery/strain turquoise, stress amber). When omitted — the anatomy
 * detail view — the gradient falls back to the score's band token
 * (green/yellow/red), preserving the band semantics there. The band is always
 * carried by `data-band` + the band word the tile renders + the aria-label,
 * regardless of the ring hue.
 */

// The SVG is a fixed 0 0 100 100 viewBox; CSS scales it to `dims.px`.
const VIEW = 100;
const STROKE = 9; // ~9% of size → Apple-class thinness (was ~22%).
const R = (VIEW - STROKE) / 2; // radius so the stroke sits inside the box.
const C = 2 * Math.PI * R; // circumference for the dash math.
const CX = VIEW / 2;

const SIZE: Record<
  NonNullable<ScoreRingProps["size"]>,
  { px: number; numberClass: string; labelClass: string }
> = {
  sm: { px: 120, numberClass: "text-3xl", labelClass: "text-[11px]" },
  md: { px: 168, numberClass: "text-5xl", labelClass: "text-xs" },
  lg: { px: 232, numberClass: "text-7xl", labelClass: "text-sm" },
};

export interface ScoreRingProps {
  /** The 0..100 score, or `null` for the provisional/empty state. */
  score: number | null;
  /** Band override; when omitted it is derived from the score via thresholds. */
  band?: ScoreBand;
  /** Short label rendered under the number (e.g. "Readiness", "/100"). */
  label?: string;
  /** Render size. `sm` in a grid tile, `md`/`lg` on the anatomy view. */
  size?: "sm" | "md" | "lg";
  /** Disable the sweep + count-up (e.g. when already animated by a parent). */
  animate?: boolean;
  /**
   * Per-metric hue for the single-hue two-stop arc gradient. When omitted the
   * gradient falls back to the score's band token (green/yellow/red) — the
   * anatomy detail view keeps band semantics that way.
   */
  hue?: RingHue;
  /**
   * Retained for API compatibility. The premium redesign drops the old
   * white-arc-on-dark-slab treatment in favour of the per-metric `hue`
   * gradient on the gentle `.wellness-tile`, so this no longer changes the
   * paint; it is kept so existing call sites + tests don't break.
   */
  variant?: "band" | "onGradient";
  className?: string;
}

export function ScoreRing({
  score,
  band,
  label,
  size = "md",
  animate = true,
  hue,
  className,
}: ScoreRingProps) {
  const { t } = useTranslations();
  const dims = SIZE[size];
  const gid = useId();

  const hasScore = score != null && Number.isFinite(score);
  const clamped = hasScore ? clampScore(score) : 0;
  const resolvedBand: ScoreBand = band ?? bandForScore(clamped);

  // Single-hue two-stop gradient. The per-metric `hue` leans the colour
  // (Oura's move); with no `hue` the anatomy view falls back to the band
  // token so its green/yellow/red semantics survive.
  const [from, to] = RING_GRADIENT[hue ?? resolvedBand];

  const reduced = prefersReducedMotion();
  const dash = (clamped / 100) * C;

  // Count-up only feeds the centred number; the arc sweeps via the CSS
  // stroke-dashoffset transition (or paints final under reduced motion).
  const displayed = useCountUp(clamped, {
    enabled: animate && hasScore && !reduced,
  });
  const displayedRounded = Math.round(displayed);

  const ariaLabel = hasScore
    ? t("insights.derived.scoreRing.aria", {
        score: Math.round(clamped),
        band: t(`insights.derived.scoreRing.band.${resolvedBand}`),
      })
    : t("insights.derived.scoreRing.ariaProvisional");

  return (
    <div
      data-slot="score-ring"
      data-band={hasScore ? resolvedBand : "none"}
      data-provisional={hasScore ? undefined : "true"}
      role="img"
      aria-label={ariaLabel}
      className={cn("relative shrink-0", className)}
      style={{ width: dims.px, height: dims.px }}
    >
      <svg
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        className="h-full w-full -rotate-90"
        aria-hidden="true"
      >
        <defs>
          {/* Single-hue two-stop gradient — JSX SVG, not dangerouslySetInnerHTML. */}
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={from} />
            <stop offset="100%" stopColor={to} />
          </linearGradient>
        </defs>
        {/* Faint same-hue track — 12% of the ring colour, never a bright
            competing ring. */}
        <circle
          cx={CX}
          cy={CX}
          r={R}
          fill="none"
          stroke={`url(#${gid})`}
          strokeOpacity={0.12}
          strokeWidth={STROKE}
        />
        {/* The progress arc — single-hue gradient, round cap. */}
        <circle
          cx={CX}
          cy={CX}
          r={R}
          fill="none"
          stroke={`url(#${gid})`}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={C}
          style={
            reduced
              ? { strokeDashoffset: C - dash }
              : {
                  strokeDashoffset: C - dash,
                  transition:
                    "stroke-dashoffset 700ms cubic-bezier(.22,.61,.36,1)",
                }
          }
        />
      </svg>
      {/* Centred number as real DOM text — easier to style with the design
          tokens + tabular-nums, and no SVG-text clipping on a long label. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span
          className={cn(
            "font-semibold tracking-tight tabular-nums",
            dims.numberClass,
            hasScore ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {hasScore ? displayedRounded : "—"}
        </span>
        {label ? (
          <span className={cn("text-muted-foreground", dims.labelClass)}>
            {label}
          </span>
        ) : null}
      </div>
      {!hasScore && (
        <span
          data-slot="score-ring-provisional"
          className="text-muted-foreground absolute inset-x-0 bottom-0 line-clamp-1 px-1 text-center text-[10px] leading-tight"
        >
          {t("insights.derived.scoreRing.provisionalCaption")}
        </span>
      )}
    </div>
  );
}
