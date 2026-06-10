"use client";

import { useEffect, useId, useState } from "react";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { useCountUp } from "@/hooks/use-count-up";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { bandForScore, clampScore, type ScoreBand } from "./band-tokens";
import { RING_GRADIENT, RING_GLOW, type RingHue } from "./ring-hues";

/**
 * v1.14.0 — the composite-score dial: a hand-rolled SVG arc gauge with a
 * premium "signature reveal" (Oura/WHOOP-tier), 0 KB runtime, no animation
 * library. A score dial is a fixed-geometry gauge, not a data chart, so SVG
 * gives exact control over a thin round-cap arc, a segmented same-hue track,
 * a single-hue two-stop gradient, a faint "vs your baseline" ghost arc, and a
 * token-tinted bloom — all CSS-driven.
 *
 * Motion (all CSS-first, all gated on `prefers-reduced-motion`):
 *   • the arc sweeps from empty on mount via a `linear()` SPRING that
 *     overshoots ~6% then settles (`--ring-spring`); the spring is swapped for
 *     a plain ease-out above score 94 so a high arc never wraps past full;
 *   • `delayMs` staggers the sweep + the count-up so the strip reveals
 *     left-to-right and each number trails its arc;
 *   • a conic SHEEN + the tile rise + glow live in `globals.css`, gated on the
 *     strip's `data-revealed` flag (set once per session) so a background
 *     refetch never re-triggers the moment.
 *
 * The arc/track/ghost are real SVG JSX (`<linearGradient>` is NOT
 * `dangerouslySetInnerHTML`). The `<svg>` is rotated -90° so the arc starts at
 * 12 o'clock and sweeps clockwise without per-point trig. The centred number
 * is real DOM text so a long label never clips under the viewBox.
 *
 * `score === null` renders the provisional/empty state. a11y: `role="img"` +
 * an aria-label restating number + band, so the ring is never colour-only;
 * the band always rides `data-band` regardless of arc hue.
 */

// The SVG is a fixed 0 0 100 100 viewBox; CSS scales it to `dims.px`.
const VIEW = 100;
const STROKE = 9; // ~9% of size → Apple-class thinness.
const R = (VIEW - STROKE) / 2; // radius so the stroke sits inside the box.
const C = 2 * Math.PI * R; // circumference for the dash math.
const CX = VIEW / 2;
// Above this score the spring overshoot (~6% of the swept distance) would push
// the arc past a full circle and wrap — use a non-overshoot ease-out instead.
const SPRING_SAFE_MAX = 94;

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
  /** Disable the sweep + count-up (e.g. when already revealed this session). */
  animate?: boolean;
  /**
   * Per-metric hue for the single-hue two-stop arc gradient. When omitted the
   * gradient falls back to the score's band token (green/yellow/red) — the
   * anatomy detail view keeps band semantics that way.
   */
  hue?: RingHue;
  /**
   * Stagger offset (ms): delays the arc sweep + the count-up start so a row of
   * rings reveals left-to-right and each number trails its own arc.
   */
  delayMs?: number;
  /**
   * Optional "your normal" reference (0..100). When set + finite, a faint
   * thinner ghost arc renders under the live arc so the user sees today vs
   * their baseline at a glance. Omit (null) when no trailing series exists.
   */
  baseline?: number | null;
  /**
   * Retained for API compatibility. The premium redesign drops the old
   * white-arc-on-dark-slab treatment in favour of the per-metric `hue`
   * gradient, so this no longer changes the paint; kept so existing call sites
   * + tests don't break.
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
  delayMs = 0,
  baseline,
  className,
}: ScoreRingProps) {
  const { t } = useTranslations();
  const dims = SIZE[size];
  const gid = useId();

  const hasScore = score != null && Number.isFinite(score);
  const clamped = hasScore ? clampScore(score) : 0;
  const resolvedBand: ScoreBand = band ?? bandForScore(clamped);
  const hueKey = hue ?? resolvedBand;

  // Single-hue two-stop gradient. The per-metric `hue` leans the colour
  // (Oura's move); with no `hue` the anatomy view falls back to the band token.
  const [from, to] = RING_GRADIENT[hueKey];
  const glow = RING_GLOW[hueKey];

  const reduced = prefersReducedMotion();
  const shouldAnimate = animate && hasScore && !reduced;
  const dash = (clamped / 100) * C;

  const hasBaseline = baseline != null && Number.isFinite(baseline) && hasScore;
  const baselineDash = hasBaseline ? (clampScore(baseline) / 100) * C : 0;

  // Arc starts empty (offset C) and sweeps to its fill on the next frame after
  // mount, so the spring transition actually plays on first paint (transitions
  // don't run on the initial commit). With motion off, it paints final at once.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!shouldAnimate) return;
    const raf = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(raf);
  }, [shouldAnimate]);
  const filled = !shouldAnimate || armed;

  const easing =
    clamped > SPRING_SAFE_MAX ? "var(--ring-ease)" : "var(--ring-spring)";

  const displayed = useCountUp(clamped, {
    enabled: shouldAnimate,
    durationMs: 1000,
    startDelayMs: delayMs + 180,
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
      style={
        {
          width: dims.px,
          height: dims.px,
          "--ring-glow": glow,
        } as React.CSSProperties
      }
    >
      {/* `overflow-visible`: the arc's drop-shadow bloom (`.wellness-ring-arc`)
          paints outside the viewBox — the arc fills the 0 0 100 100 box, so the
          default `overflow: hidden` on SVG clipped the glow flat at the circle's
          edge. The -90° rotation is unaffected (the bloom is radially symmetric)
          and the parent div never clips, so the glow now feathers out fully. */}
      <svg
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        className="h-full w-full -rotate-90 overflow-visible"
        aria-hidden="true"
      >
        <defs>
          {/* Single-hue two-stop gradient — JSX SVG, not dangerouslySetInnerHTML. */}
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={from} />
            <stop offset="100%" stopColor={to} />
          </linearGradient>
        </defs>
        {/* Segmented same-hue tick track — reads as an instrument, not a bar. */}
        <circle
          cx={CX}
          cy={CX}
          r={R}
          fill="none"
          stroke={`url(#${gid})`}
          strokeOpacity={0.16}
          strokeWidth={STROKE}
          strokeDasharray="0.5 4.2"
        />
        {/* "vs your baseline" ghost arc — thinner, faint, under the live arc. */}
        {hasBaseline ? (
          <circle
            cx={CX}
            cy={CX}
            r={R}
            fill="none"
            stroke={`url(#${gid})`}
            strokeOpacity={0.3}
            strokeWidth={STROKE * 0.42}
            strokeLinecap="round"
            strokeDasharray={C}
            style={{
              strokeDashoffset: filled ? C - baselineDash : C,
              transition: shouldAnimate
                ? `stroke-dashoffset 420ms var(--ring-ease) ${delayMs}ms`
                : undefined,
            }}
          />
        ) : null}
        {/* The progress arc — single-hue gradient, round cap, spring sweep, bloom. */}
        <circle
          className={cn(
            "wellness-ring-arc",
            shouldAnimate &&
              resolvedBand === "green" &&
              "wellness-ring-arc--pulse",
          )}
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
            transition: shouldAnimate
              ? `stroke-dashoffset 1150ms ${easing} ${delayMs}ms`
              : undefined,
          }}
        />
      </svg>
      {/* Conic specular sheen — sweeps the arc once on the strip reveal. */}
      <div className="wellness-ring-sheen" aria-hidden="true" />
      {/* Centred number as real DOM text — design tokens + tabular-nums. */}
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
