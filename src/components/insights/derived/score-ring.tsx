"use client";

import {
  Label,
  PolarRadiusAxis,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
} from "recharts";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { useCountUp } from "@/hooks/use-count-up";
import {
  bandForScore,
  BAND_VAR,
  clampScore,
  type ScoreBand,
} from "./band-tokens";

/**
 * v1.10.0 — the composite-score dial. A radial Recharts ring with the
 * `tabular-nums` number centred, band-coloured, sweeping to fill on first
 * paint. Rendered small in a grid tile and large on the score-anatomy
 * detail view from the same component via the `size` prop — one score
 * language, two intensities (the Hybrid direction).
 *
 * Built on raw Recharts `RadialBarChart` (the existing house pattern — 6
 * sites already use Recharts via `ResponsiveContainer`), NOT the shadcn
 * `chart` primitive: the ring needs no per-series CSS-var injection, so it
 * paints its fill straight from the `--dracula-*` band token and avoids
 * adding a second `dangerouslySetInnerHTML` to the tree. 0 KB new runtime.
 *
 * `score === null` renders the provisional/empty state: an unfilled ring
 * with an em-dash and a localised "not enough data yet" caption, so a
 * sparse-data hero never goes blank.
 *
 * a11y: `role="img"` + an aria-label restating the number and band, so the
 * ring is never colour-only. `prefers-reduced-motion` disables the sweep
 * (Recharts `isAnimationActive`) and the count-up.
 *
 * `variant` picks the arc palette. `"band"` (default) paints the filled
 * arc in the score's band token (green/yellow/red) over a muted track —
 * the legible treatment on a plain `bg-card` surface (the score-anatomy
 * detail view). `"onGradient"` paints a WHITE arc over a translucent-white
 * track for use on the saturated `.score-tile-gradient` wellness cards,
 * where a band tint would muddy against the purple/pink and white reads at
 * high contrast. The band semantic is never lost to the white arc: it
 * still rides the `data-band` attribute, the aria-label, and the band-word
 * label the wellness tile renders beneath the ring.
 */

const SIZE: Record<
  NonNullable<ScoreRingProps["size"]>,
  { px: number; numberClass: string; labelClass: string; barSize: number }
> = {
  sm: { px: 96, numberClass: "text-2xl", labelClass: "text-[10px]", barSize: 10 },
  md: { px: 140, numberClass: "text-4xl", labelClass: "text-xs", barSize: 14 },
  lg: { px: 200, numberClass: "text-6xl", labelClass: "text-sm", barSize: 18 },
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
   * Arc palette. `"band"` (default) tints the arc by score band over a
   * muted track — legible on a plain card. `"onGradient"` paints a white
   * arc over a translucent-white track, for the saturated gradient
   * wellness tiles. See the component doc for why the band semantic is not
   * lost to the white arc.
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
  variant = "band",
  className,
}: ScoreRingProps) {
  const { t } = useTranslations();
  const dims = SIZE[size];
  const onGradient = variant === "onGradient";

  const hasScore = score != null && Number.isFinite(score);
  const clamped = hasScore ? clampScore(score) : 0;
  const resolvedBand: ScoreBand = band ?? bandForScore(clamped);
  const fill = onGradient
    ? "#ffffff"
    : hasScore
      ? BAND_VAR[resolvedBand]
      : "var(--muted-foreground)";

  // Count-up only feeds the centred number; the ring arc reads the final
  // value (Recharts owns its own sweep via isAnimationActive).
  const displayed = useCountUp(clamped, { enabled: animate && hasScore });
  const displayedRounded = Math.round(displayed);

  const ariaLabel = hasScore
    ? t("insights.derived.scoreRing.aria", {
        score: Math.round(clamped),
        band: t(`insights.derived.scoreRing.band.${resolvedBand}`),
      })
    : t("insights.derived.scoreRing.ariaProvisional");

  // RadialBar fills the arc proportionally to the bar's value against the
  // PolarRadiusAxis [0,100] domain; the track spans a full clockwise circle
  // from 12 o'clock, so a value of 74 fills 74% of the ring.
  const data = [{ name: "score", value: hasScore ? clamped : 0, fill }];
  const startAngle = 90;
  const endAngle = -270;

  // Geometry — keep the inner ring thin and the centre clear for the number.
  const outerRadius = "100%";
  const innerRadius = "78%";

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
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart
          data={data}
          startAngle={startAngle}
          endAngle={endAngle}
          innerRadius={innerRadius}
          outerRadius={outerRadius}
          barSize={dims.barSize}
        >
          <RadialBar
            dataKey="value"
            background={
              onGradient
                ? { fill: "#ffffff", opacity: 0.18 }
                : { fill: "var(--muted)", opacity: 0.4 }
            }
            cornerRadius={dims.barSize}
            isAnimationActive={animate && hasScore}
            animationDuration={600}
            aria-hidden
          />
          <PolarRadiusAxis
            type="number"
            domain={[0, 100]}
            tick={false}
            tickLine={false}
            axisLine={false}
          >
            <Label
              content={({ viewBox }) => {
                if (!viewBox || !("cx" in viewBox) || !("cy" in viewBox)) {
                  return null;
                }
                const cx = viewBox.cx ?? 0;
                const cy = viewBox.cy ?? 0;
                return (
                  <text
                    x={cx}
                    y={cy}
                    textAnchor="middle"
                    dominantBaseline="middle"
                  >
                    <tspan
                      x={cx}
                      y={cy}
                      className={cn(
                        "font-semibold tabular-nums",
                        dims.numberClass,
                        // v1.12.6 — the centred number reads in the
                        // foreground colour (white on the dark wellness
                        // card, near-black on the light card), never the
                        // band tint. The band-coloured number cleared only
                        // ~1.5:1 on `--card` and read as illegible. The
                        // band semantic is carried by the ring arc
                        // (`fill` = BAND_VAR) + the `data-band` attribute +
                        // the aria-label, so dropping it from the number
                        // costs no information while clearing AA.
                        // On the saturated gradient tile the number is
                        // pinned white in both themes (the dark gradient
                        // clears AA either way); `fill-foreground` would go
                        // near-black on the Alucard light card and vanish.
                        onGradient
                          ? "fill-white"
                          : hasScore
                            ? "fill-foreground"
                            : "fill-muted-foreground",
                      )}
                    >
                      {hasScore ? displayedRounded : "—"}
                    </tspan>
                    {label ? (
                      <tspan
                        x={cx}
                        y={cy + (size === "lg" ? 30 : size === "md" ? 22 : 16)}
                        className={cn(
                          // On the gradient tile a translucent white reads
                          // cleanly; on a plain card the muted-foreground
                          // token keeps the sub-label quiet.
                          onGradient
                            ? "fill-white/80"
                            : "fill-muted-foreground",
                          dims.labelClass,
                        )}
                      >
                        {label}
                      </tspan>
                    ) : null}
                  </text>
                );
              }}
            />
          </PolarRadiusAxis>
        </RadialBarChart>
      </ResponsiveContainer>
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
