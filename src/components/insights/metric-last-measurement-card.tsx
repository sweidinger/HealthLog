"use client";

import { Clock } from "lucide-react";

import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { formatRelativeTime } from "@/lib/i18n/relative-time";

/**
 * v1.12.0 — canonical "Letzte Messung" card.
 *
 * The third block on the per-metric detail page (after the primary
 * tile), mirroring the iOS `InsightsLastMeasurementCard`. It captions
 * WHEN the most recent reading landed — the date plus a "vor X Tagen"
 * recency line.
 *
 * It deliberately does NOT repeat the latest value: the headline value
 * lives in `<MetricPrimaryTile>` only (the no-duplicate-info rule). This
 * card owns the timing dimension; the primary tile owns the value.
 *
 * Self-suppressing: renders nothing when no `lastSeenAt` is available
 * (a brand-new metric, or a metric whose freshness map has no entry),
 * so a sparse page never carries an empty timing card.
 */

interface MetricLastMeasurementCardProps {
  /**
   * ISO timestamp of the latest reading for this metric, read from the
   * analytics `lastSeenByType[type]?.lastSeenAt` slot. Null / undefined
   * suppresses the card.
   */
  lastSeenAt: string | null | undefined;
}

export function MetricLastMeasurementCard({
  lastSeenAt,
}: MetricLastMeasurementCardProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  if (!lastSeenAt) return null;
  const parsed = new Date(lastSeenAt);
  if (Number.isNaN(parsed.getTime())) return null;

  return (
    <section
      data-slot="metric-last-measurement"
      className="bg-card border-border flex items-center gap-3 rounded-xl border px-4 py-3"
    >
      <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-full">
        <Clock className="size-4" aria-hidden="true" />
      </div>
      <div className="min-w-0 space-y-0.5">
        <p className="text-muted-foreground text-[0.6875rem] font-medium tracking-[0.06em] uppercase">
          {t("insights.subPage.lastMeasurement.label")}
        </p>
        <p className="text-sm font-medium">
          {fmt.dateWithWeekday(parsed)}
          <span className="text-muted-foreground ml-2 font-normal">
            {formatRelativeTime(lastSeenAt, t)}
          </span>
        </p>
      </div>
    </section>
  );
}
