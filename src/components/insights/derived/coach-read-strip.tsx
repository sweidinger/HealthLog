"use client";

import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { cn } from "@/lib/utils";
import type { CoachReadStripData } from "@/lib/insights/derived/coach-read-shape";

/**
 * v1.22.0 (A1) — "Coach read" strip.
 *
 * A compact two-line read rendered ABOVE the chart on each metric sub-page:
 *
 *   1. own-baseline — "Your usual range is X–Y; today's Z sits within /
 *      above / below". Below the engine's 7-day history floor it reads
 *      "still learning your range" — never a fabricated band.
 *   2. one lagged association — the single strongest discovered driver whose
 *      outcome is this metric, stated in the engine's own never-causal voice.
 *      Omitted entirely when no driver clears the existing effect-size floor.
 *
 * Server-authoritative: the component only renders the resolved DTO from
 * `/api/insights/coach-read`. It never re-derives a band or a correlation, so
 * the web and iOS strips read identical numbers. The strip self-gates: it
 * paints nothing until the read lands, and nothing at all when there is no
 * baseline AND no driver (a brand-new metric stays clean).
 */

export interface CoachReadStripProps {
  /** The MeasurementType the route keys on (e.g. `WEIGHT`, `RESTING_HEART_RATE`). */
  metricType: string;
  /** Unit suffix rendered next to the band edges + today's value. */
  unit: string;
  /**
   * Decimal precision for the formatted numbers. Defaults to 1 — enough for
   * weight (78.4) / HRV (41.5); integer metrics drop the trailing zero via
   * `Intl.NumberFormat`. Pages pass 0 for integer-only metrics (BP, steps).
   */
  fractionDigits?: number;
  /**
   * Display-time value scale folded into the band edges + today's value (e.g.
   * WALKING_SPEED stores m/s but renders km/h via `valueScale={3.6}`). The
   * server computes the placement on unscaled stored values (scale-invariant),
   * so scaling here only affects the displayed numbers. Defaults to 1.
   */
  valueScale?: number;
}

export function CoachReadStrip({
  metricType,
  unit,
  fractionDigits = 1,
  valueScale = 1,
}: CoachReadStripProps) {
  const { isAuthenticated } = useAuth();
  const { t, locale } = useTranslations();
  const mounted = useMounted();

  const { data } = useQuery({
    queryKey: queryKeys.insightsCoachRead(metricType),
    queryFn: () =>
      apiGet<CoachReadStripData>(
        `/api/insights/coach-read?metric=${encodeURIComponent(metricType)}`,
      ),
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000,
  });

  // Match the rest of the query-dependent insights chrome: don't paint a
  // branch during SSR / hydration (React #418) and don't paint until the
  // read lands.
  if (!mounted || !data) return null;

  const fmt = (value: number): string =>
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: 0,
      maximumFractionDigits: fractionDigits,
    }).format(value * valueScale);

  const baselineLine = ((): string | null => {
    if (data.learning || !data.baseline) {
      return t("insights.coach.readStrip.insufficient");
    }
    const { low, high, latest, placement } = data.baseline;
    const key =
      placement === "above"
        ? "insights.coach.readStrip.baselineAbove"
        : placement === "below"
          ? "insights.coach.readStrip.baselineBelow"
          : "insights.coach.readStrip.baselineWithin";
    return t(key, {
      low: fmt(low),
      high: fmt(high),
      value: fmt(latest),
      unit,
    });
  })();

  const driverLine = data.driver
    ? t("insights.coach.readStrip.driver", { note: data.driver.note })
    : null;

  // Self-gate: nothing to say when both lines are absent. (The baseline line
  // is always non-null — it degrades to the "learning" copy — so this only
  // fires defensively.)
  if (!baselineLine && !driverLine) return null;

  return (
    <div
      data-slot="coach-read-strip"
      className={cn(
        "bg-card/60 border-border/60 rounded-xl border px-3.5 py-2.5",
        "text-muted-foreground space-y-1 text-sm leading-relaxed",
      )}
    >
      <div className="flex items-start gap-2">
        <Sparkles
          className="text-primary/70 mt-0.5 size-3.5 shrink-0"
          aria-hidden="true"
        />
        <div className="min-w-0 space-y-1">
          <span className="text-foreground/70 sr-only text-xs font-medium">
            {t("insights.coach.readStrip.label")}
          </span>
          {baselineLine ? (
            <p data-slot="coach-read-baseline" className="text-pretty">
              {baselineLine}
            </p>
          ) : null}
          {driverLine ? (
            <p
              data-slot="coach-read-driver"
              className="text-muted-foreground/90 text-pretty"
            >
              {driverLine}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
