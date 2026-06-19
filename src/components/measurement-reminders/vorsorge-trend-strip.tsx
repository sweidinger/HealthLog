"use client";

/**
 * v1.18.7 (Wave E) — a small, DISCREET 7-day trend strip for a Vorsorge
 * card. Renders the reminder metric's last seven readings as seven quiet
 * bars (newest → rightmost), heights normalised across the window. The
 * colour is intentionally muted (`bg-muted-foreground/30`) so the strip
 * reads as calm context sitting under the metric — never an alarming
 * status signal, in keeping with the no-loud-colour card ethos.
 *
 * Pulls the bounded last-7 readings for one `MeasurementType` through the
 * existing measurements list endpoint (a single `limit=7` read per card,
 * cached by type) — no new heavy aggregate query. A free-text reminder
 * (no `measurementType`) renders nothing; a metric with fewer than two
 * readings in the window renders nothing (a single dot is no trend).
 */
import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

interface RecentMeasurement {
  value: number;
  measuredAt: string;
}

/**
 * Bounded last-7 read for one measurement type, sorted newest-first by the
 * server. Re-sorted oldest → newest here so the bars read left (older) to
 * right (newest). Shares the `measurements` invalidation prefix so a fresh
 * reading (e.g. completing this very reminder) repaints the strip.
 */
function useRecentValues(measurementType: string | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.measurementRecentValues(measurementType ?? ""),
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("type", measurementType as string);
      params.set("limit", "7");
      params.set("sortBy", "measuredAt");
      params.set("sortDir", "desc");
      const res = await apiGet<{ measurements: RecentMeasurement[] }>(
        `/api/measurements?${params}`,
      );
      return res.measurements
        .slice()
        .reverse()
        .map((m) => m.value);
    },
    enabled: enabled && measurementType != null,
  });
}

export function VorsorgeTrendStrip({
  measurementType,
  enabled = true,
}: {
  measurementType: string | null;
  enabled?: boolean;
}) {
  const { t } = useTranslations();
  const { data } = useRecentValues(measurementType, enabled);

  // Nothing to show for a free-text reminder or a too-thin window.
  if (measurementType == null) return null;
  const values = data ?? [];
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  return (
    <div
      className="flex h-6 items-end gap-0.5"
      role="img"
      aria-label={t("measurementReminders.trendStrip.label")}
    >
      {values.map((v, i) => {
        // Floor at ~18% so a flat series still reads as bars, not a line.
        const pct = 0.18 + ((v - min) / span) * 0.82;
        return (
          <span
            key={i}
            className="bg-muted-foreground/30 w-1.5 rounded-sm"
            style={{ height: `${Math.round(pct * 100)}%` }}
          />
        );
      })}
    </div>
  );
}
