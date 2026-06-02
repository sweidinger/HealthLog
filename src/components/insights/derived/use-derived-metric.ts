"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type {
  DerivedCoverage,
  DerivedConfidence,
  DerivedProvenance,
} from "@/lib/insights/derived/types";

/**
 * v1.10.0 — TanStack Query hook for the generic derived-metric route.
 *
 * `GET /api/insights/derived?metric=<id>[&type=<vital>]` returns the
 * compute-once flattened `Derived<T>` the W2b dashboard tiles + per-metric
 * detail cards read. The queryKey comes from the centralised factory
 * (`queryKeys.insightsDerived`) so the bare-array ESLint rule stays
 * satisfied and the cache never poisons across metrics; the read unwraps
 * `(await res.json()).data` per the envelope convention.
 *
 * Type-only import of the `Derived<T>` facets — no server module enters the
 * client bundle (the v1.9.0 lesson). The value `T` is left generic so each
 * caller narrows to its own metric payload (`FitnessAgeValue`, `BmiValue`, …)
 * imported as `import type`.
 */

/** The flattened wire shape the route emits in the `data` envelope slot. */
export interface DerivedMetricResponse<T> {
  metric: string;
  status: "ok" | "insufficient";
  value: T | null;
  coverage: DerivedCoverage;
  confidence: DerivedConfidence | null;
  provenance: DerivedProvenance;
  reason: string | null;
}

export interface UseDerivedMetricOptions {
  /** Optional sub-target (the chosen vital for `VITALS_BASELINE`). */
  type?: string | null;
  /** Gate the fetch (e.g. on auth). Defaults to enabled. */
  enabled?: boolean;
}

export function useDerivedMetric<T>(
  metric: string,
  options: UseDerivedMetricOptions = {},
) {
  const { type = null, enabled = true } = options;
  return useQuery({
    queryKey: queryKeys.insightsDerived(metric, type),
    queryFn: async (): Promise<DerivedMetricResponse<T>> => {
      const params = new URLSearchParams({ metric });
      if (type) params.set("type", type);
      const res = await fetch(`/api/insights/derived?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`derived ${metric} request failed (${res.status})`);
      }
      return (await res.json()).data as DerivedMetricResponse<T>;
    },
    enabled,
    // Pure compute over the rollup tier — cheap to recompute, but the
    // numbers only move on a fresh ingest. A short stale window keeps the
    // dashboard snappy without hammering the route on every focus.
    staleTime: 60_000,
  });
}
