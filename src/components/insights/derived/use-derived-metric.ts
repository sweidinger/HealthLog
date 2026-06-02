"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import type {
  DerivedCoverage,
  DerivedConfidence,
  DerivedProvenance,
} from "@/lib/insights/derived/types";

/**
 * v1.10.0 — the single TanStack Query hook for the generic derived-metric
 * route, shared by every client surface (vitals dashboard tiles, composite
 * score-anatomy, the home wellness strip).
 *
 * `GET /api/insights/derived?metric=<id>[&type=<vital>]` returns the
 * compute-once flattened `Derived<T>` the surfaces read. The queryKey comes
 * from the centralised factory (`queryKeys.insightsDerived`) so the bare-array
 * ESLint rule stays satisfied and the cache never poisons across metrics; the
 * read unwraps `(await res.json()).data` per the envelope convention.
 *
 * Pure compute on the server (sub-second on a warm rollup tenant) — so the
 * hook bounds the fetch on an 8 s client ceiling (a slow response means a
 * degraded network, not a provider call), keeps a 60 s `staleTime`, gates on
 * auth, and never inline-retries. These reads NEVER warm/generate on visit —
 * they read already-computed rollup values (the v1.4.36 / v1.9.1 lesson: a
 * warm-on-mount fan-out looks like the app hanging).
 *
 * Type-only import of the `Derived<T>` facets — no server module enters the
 * client bundle (the v1.9.0 lesson). The value `T` is left generic so each
 * caller narrows to its own metric payload (`FitnessAgeValue`, `BmiValue`, …)
 * imported as `import type`.
 */

const DERIVED_TIMEOUT_MS = 8_000;

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
  /** Gate the fetch (e.g. on a surface flag). Defaults to enabled. */
  enabled?: boolean;
}

export function useDerivedMetric<T>(
  metric: string,
  options: UseDerivedMetricOptions = {},
) {
  const { type = null, enabled = true } = options;
  const { isAuthenticated } = useAuth();
  const gated = enabled && isAuthenticated && metric !== "";

  return useQuery({
    queryKey: queryKeys.insightsDerived(metric, type),
    queryFn: async (): Promise<DerivedMetricResponse<T>> => {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(
        () => controller.abort(),
        DERIVED_TIMEOUT_MS,
      );
      try {
        const params = new URLSearchParams({ metric });
        if (type) params.set("type", type);
        const res = await fetch(`/api/insights/derived?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`derived ${metric} request failed (${res.status})`);
        }
        return (await res.json()).data as DerivedMetricResponse<T>;
      } finally {
        clearTimeout(timeoutHandle);
      }
    },
    enabled: gated,
    staleTime: 60_000,
    retry: 0,
  });
}
