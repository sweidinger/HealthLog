import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.4.16 phase B5d — `<ConfidenceMeter>`.
 *
 * Renders a deterministic 0..100 confidence score (server-computed by
 * `computeConfidence()` and overridden in `generateInsight()`) as
 * either a 5-bar meter (default) or an SVG ring.
 *
 * Color bands match research §2.A "three-band visual" extended to 4
 * bands so the under-50 region splits into "low" + "draft":
 *
 *   - >=80: green ("high"), 5 bars / full ring
 *   - 50..79: yellow ("medium"), 3-4 bars
 *   - 25..49: orange ("low"), 2 bars / partial ring + caption
 *   - <25: "draft" pill REPLACES the meter — Apple's
 *     "quiet-when-unsure" affordance per research §2.A. The rec is
 *     drafted but the model isn't asserting it.
 *
 * aria-label always announces the numeric score so a screen reader
 * isn't blind to the visual band distinction. Mobile-friendly: the
 * bars variant fits in 56 px wide; the ring variant in 28×28.
 */

export type ConfidenceBand = "high" | "medium" | "low" | "draft";
export type ConfidenceMeterVariant = "bars" | "ring";

export interface ConfidenceMeterProps {
  /** Score from `computeConfidence()` — 0..100, integer expected. */
  value: number;
  /** Visual variant. Defaults to `bars`. */
  variant?: ConfidenceMeterVariant;
  /** Optional className applied to the outer wrapper. */
  className?: string;
}

const DRAFT_THRESHOLD = 25;

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
}

function bandFor(value: number): ConfidenceBand {
  if (value < DRAFT_THRESHOLD) return "draft";
  if (value < 50) return "low";
  if (value < 80) return "medium";
  return "high";
}

/**
 * Lit-bar count = ceil(value / 20). 0..20 is 1, 21..40 is 2, etc.
 * Note: when band is "draft" we don't render bars at all, so this
 * helper is only consulted for non-draft bands. We still clamp to
 * [1, 5] to defend against off-by-one drift.
 */
function litBarsFor(value: number): number {
  const lit = Math.ceil(value / 20);
  if (lit < 1) return 1;
  if (lit > 5) return 5;
  return lit;
}

const BAR_LIT_COLOUR_BY_BAND: Record<Exclude<ConfidenceBand, "draft">, string> =
  {
    high: "bg-dracula-green",
    medium: "bg-dracula-yellow",
    low: "bg-dracula-orange",
  };

const RING_STROKE_COLOUR_BY_BAND: Record<
  Exclude<ConfidenceBand, "draft">,
  string
> = {
  high: "stroke-dracula-green",
  medium: "stroke-dracula-yellow",
  low: "stroke-dracula-orange",
};

function DraftPill({ ariaLabel }: { ariaLabel: string }) {
  const { t } = useTranslations();
  return (
    <span
      data-confidence-band="draft"
      role="img"
      aria-label={ariaLabel}
      className="bg-dracula-red/10 text-dracula-red border-dracula-red/25 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase"
    >
      {t("insights.recommendation.confidenceDraft")}
    </span>
  );
}

function BarsMeter({
  value,
  band,
  ariaLabel,
}: {
  value: number;
  band: Exclude<ConfidenceBand, "draft">;
  ariaLabel: string;
}) {
  const lit = litBarsFor(value);
  const litColour = BAR_LIT_COLOUR_BY_BAND[band];
  return (
    <span
      data-confidence-band={band}
      role="img"
      aria-label={ariaLabel}
      className="inline-flex items-end gap-[2px]"
    >
      {[1, 2, 3, 4, 5].map((i) => {
        const isLit = i <= lit;
        // Bars rise in height to give a visual "more is more" cue
        // independent of colour (accessibility): 4 / 6 / 8 / 10 / 12 px.
        const heightClass = ["h-1", "h-1.5", "h-2", "h-2.5", "h-3"][i - 1];
        return (
          <span
            key={i}
            data-bar-index={i}
            data-bar-state={isLit ? "lit" : "unlit"}
            className={`w-[3px] rounded-sm ${heightClass} ${
              isLit ? litColour : "bg-muted/40"
            }`}
          />
        );
      })}
    </span>
  );
}

function RingMeter({
  value,
  band,
  ariaLabel,
}: {
  value: number;
  band: Exclude<ConfidenceBand, "draft">;
  ariaLabel: string;
}) {
  const stroke = RING_STROKE_COLOUR_BY_BAND[band];
  // Ring geometry: r=10, circumference=2π·10≈62.83. Fill ratio = value/100.
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const dashArray = circumference;
  const dashOffset = circumference * (1 - value / 100);
  return (
    <svg
      data-confidence-band={band}
      role="img"
      aria-label={ariaLabel}
      width="28"
      height="28"
      viewBox="0 0 28 28"
      fill="none"
    >
      <circle
        cx="14"
        cy="14"
        r={radius}
        className="stroke-muted/30"
        strokeWidth="3"
      />
      <circle
        cx="14"
        cy="14"
        r={radius}
        className={stroke}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={dashArray}
        strokeDashoffset={dashOffset}
        transform="rotate(-90 14 14)"
      />
    </svg>
  );
}

export function ConfidenceMeter({
  value,
  variant = "bars",
  className,
}: ConfidenceMeterProps) {
  const { t } = useTranslations();
  const clamped = clamp(value);
  const band = bandFor(clamped);
  const ariaLabel = t("insights.recommendation.confidenceAria", {
    value: clamped,
  });

  const wrapperClass = `inline-flex items-center ${className ?? ""}`.trim();

  if (band === "draft") {
    return (
      <span data-slot="confidence-meter" className={wrapperClass}>
        <DraftPill ariaLabel={ariaLabel} />
      </span>
    );
  }

  return (
    <span data-slot="confidence-meter" className={wrapperClass}>
      {variant === "ring" ? (
        <RingMeter value={clamped} band={band} ariaLabel={ariaLabel} />
      ) : (
        <BarsMeter value={clamped} band={band} ariaLabel={ariaLabel} />
      )}
    </span>
  );
}
