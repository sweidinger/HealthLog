"use client";

import { useQuery } from "@tanstack/react-query";
import { Lightbulb } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { detectMeasurementDiversity } from "@/lib/insights/measurement-diversity";

/**
 * v1.8.5 — measurement-diversity nudge for the insights category pages.
 *
 * When a metric's readings cluster on a single weekday or a narrow
 * time-of-day band, the trend reads a biased slice of reality. This
 * component fetches a bounded recent window of raw timestamps for the
 * metric, runs the pure `detectMeasurementDiversity` check, and — only
 * when the spread is genuinely lopsided — surfaces a gentle hint to
 * measure on other days / times.
 *
 * v1.8.3 anti-freeze posture: the read is a bounded `limit`-capped query
 * with a 5-minute `staleTime`, fires only after the page has mounted
 * (no SSR blocking), and renders nothing while in flight or when the
 * spread is healthy. No new server route — it rides the existing
 * `/api/measurements` list endpoint.
 */

interface MeasurementDiversityNudgeProps {
  /** The page's `MeasurementType`. */
  measurementType: string;
  /** Localised metric name woven into the hint copy. */
  metricLabel: string;
  /** User's IANA timezone so weekday / hour resolve in the wall clock. */
  timeZone?: string;
}

/** Bounded window of recent rows — enough to read a pattern, never heavy. */
const WINDOW_SIZE = 120;

export function MeasurementDiversityNudge({
  measurementType,
  metricLabel,
  timeZone,
}: MeasurementDiversityNudgeProps) {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();

  const { data: timestamps } = useQuery({
    queryKey: queryKeys.measurementDiversity(measurementType),
    queryFn: async (): Promise<string[]> => {
      const params = new URLSearchParams();
      params.set("type", measurementType);
      params.set("limit", String(WINDOW_SIZE));
      params.set("sortBy", "measuredAt");
      params.set("sortDir", "desc");
      const res = await fetch(`/api/measurements?${params}`);
      if (!res.ok) return [];
      const json = await res.json();
      const rows = (json.data?.measurements ?? []) as Array<{
        measuredAt: string;
      }>;
      return rows.map((r) => r.measuredAt);
    },
    enabled: isAuthenticated,
    // The pattern shifts slowly — a 5-minute cache keeps the nudge calm
    // and shares the read budget with the rest of the page.
    staleTime: 5 * 60 * 1000,
  });

  if (!timestamps) return null;

  const signal = detectMeasurementDiversity(timestamps, timeZone);
  if (!signal) return null;

  const message = t(`insights.subPage.diversity.${signal.kind}`, {
    metric: metricLabel,
  });

  return (
    <div
      data-slot="measurement-diversity-nudge"
      role="note"
      className="bg-muted/40 text-muted-foreground flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-sm"
    >
      <Lightbulb
        className="text-dracula-yellow mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      <p className="leading-relaxed">{message}</p>
    </div>
  );
}
