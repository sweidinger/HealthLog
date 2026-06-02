"use client";

import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import type {
  DerivedConfidence,
  DerivedCoverage,
  DerivedProvenance,
} from "@/lib/insights/derived/types";

/**
 * v1.10.0 — client loader for one derived wellness metric.
 *
 * Reads the flat `Derived<T>` envelope off `/api/insights/derived?metric=…`
 * (the same shape the score-anatomy view + iOS decode). Pure compute on the
 * server — sub-second on a warm rollup tenant — so the hook bounds the fetch
 * on an 8 s client ceiling (a slow response means a degraded network, not a
 * provider call), keeps a 60 s `staleTime`, and never inline-retries.
 *
 * `T` is the metric-specific value shape (e.g. `ReadinessValue`,
 * `SleepScoreValue`); the caller supplies it so the anatomy view stays
 * strongly typed without a second cast.
 */

const DERIVED_TIMEOUT_MS = 8_000;

/** The flat wire shape the derived route returns inside `{ data }`. */
export interface DerivedMetricEnvelope<T> {
  metric: string;
  status: "ok" | "insufficient";
  value: T | null;
  coverage: DerivedCoverage;
  confidence: DerivedConfidence | null;
  provenance: DerivedProvenance;
  reason: string | null;
}

export function useDerivedMetric<T>(
  metric: string,
  options: { type?: string; enabled?: boolean } = {},
) {
  const { isAuthenticated } = useAuth();
  const enabled = (options.enabled ?? true) && isAuthenticated && metric !== "";

  return useQuery({
    queryKey: queryKeys.insightsDerivedMetric(metric, options.type),
    queryFn: async (): Promise<DerivedMetricEnvelope<T>> => {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(
        () => controller.abort(),
        DERIVED_TIMEOUT_MS,
      );
      try {
        const params = new URLSearchParams({ metric });
        if (options.type) params.set("type", options.type);
        const res = await fetch(`/api/insights/derived?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error("Failed");
        const json = (await res.json()) as { data: DerivedMetricEnvelope<T> };
        return json.data;
      } finally {
        clearTimeout(timeoutHandle);
      }
    },
    enabled,
    staleTime: 60 * 1000,
    retry: 0,
  });
}
