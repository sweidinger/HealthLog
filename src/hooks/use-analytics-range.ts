"use client";

import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import type { AnalyticsRange } from "@/lib/analytics/range-delta";

/**
 * v1.9.0 — client reader for the single-metric period-over-period range
 * read (`GET /api/analytics/range`). One cache slot per `(type, range)` via
 * the centralised query-key factory, so switching the time-range pills is a
 * cheap cache hit after first fetch and never collides with the shared
 * `["analytics", "summaries"]` slot.
 */
export interface AnalyticsWindowAggregate {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  sum: number | null;
}

export interface AnalyticsRangeData {
  range: AnalyticsRange;
  windowDays: number;
  granularity: string;
  current: AnalyticsWindowAggregate;
  previous: AnalyticsWindowAggregate;
  delta: number | null;
  deltaPct: number | null;
}

export function useAnalyticsRange(
  type: string,
  range: AnalyticsRange,
  enabled = true,
) {
  const { isAuthenticated } = useAuth();

  return useQuery({
    queryKey: queryKeys.analyticsRange(type, range),
    queryFn: async (): Promise<AnalyticsRangeData> => {
      const res = await fetch(
        `/api/analytics/range?type=${encodeURIComponent(
          type,
        )}&range=${encodeURIComponent(range)}`,
      );
      if (!res.ok) throw new Error("Failed to load range");
      const json = (await res.json()) as { data: AnalyticsRangeData };
      return json.data;
    },
    enabled: isAuthenticated && enabled && type.length > 0,
    staleTime: 60 * 1000,
  });
}
