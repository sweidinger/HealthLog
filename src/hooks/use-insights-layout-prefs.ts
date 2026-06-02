"use client";

import { useCallback, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";
import {
  resolveDashboardLayout,
  type DashboardLayout,
} from "@/lib/dashboard-layout";
import {
  ANALYTICS_RANGES,
  type AnalyticsRange,
} from "@/lib/analytics/range-shared";

const RANGE_STORAGE_KEY = "healthlog.insights.range";
const DEFAULT_RANGE: AnalyticsRange = "30d";

function isAnalyticsRange(value: string | null): value is AnalyticsRange {
  return (
    value !== null && (ANALYTICS_RANGES as readonly string[]).includes(value)
  );
}

/**
 * Read the persisted range once, lazily. Guarded by `typeof window` so the
 * server render (where `localStorage` is absent) returns the default rather
 * than throwing; the first client render then hydrates with the stored value
 * via the lazy `useState` initializer — no `setState`-in-effect needed.
 */
function readStoredRange(): AnalyticsRange {
  if (typeof window === "undefined") return DEFAULT_RANGE;
  try {
    const stored = window.localStorage.getItem(RANGE_STORAGE_KEY);
    return isAnalyticsRange(stored) ? stored : DEFAULT_RANGE;
  } catch {
    return DEFAULT_RANGE;
  }
}

/**
 * v1.9.0 — persisted time-range choice for the Insights metric pages.
 *
 * The choice sticks across metrics (a user who picks `90d` on weight sees
 * `90d` on HRV) via `localStorage` — the same lightweight client-pref seam
 * the comparison toggle conceptually lives alongside, without a server
 * round-trip or a dashboard-layout schema change. Defaults to `30d` so the
 * existing fixed-window behaviour is the default and nothing regresses.
 */
export function useInsightsRangePref() {
  const [range, setRangeState] = useState<AnalyticsRange>(readStoredRange);

  const setRange = useCallback((next: AnalyticsRange) => {
    setRangeState(next);
    try {
      window.localStorage.setItem(RANGE_STORAGE_KEY, next);
    } catch {
      // Best-effort persistence; the in-memory state still drives the UI.
    }
  }, []);

  return { range, setRange } as const;
}

/**
 * v1.4.25 W4 — shared reader for the dashboard-layout payload across
 * the insights surfaces.
 *
 * The mother page and every sub-page need the persisted
 * `comparisonBaseline` so the dashboard / insights chart-cog stays
 * in sync. The shape repeats the same `useQuery({ … queryKey:
 * queryKeys.dashboardWidgets() … })` four-line block that lived inline
 * on the mother page — extracted here so a new sub-page consumer drops
 * the boilerplate and so the TanStack-Query cache lookup stays
 * authoritative for every consumer.
 *
 * Returns the resolved `comparisonBaseline` (defaults to `"none"`)
 * directly so consumers don't have to remember the `resolveDashboardLayout`
 * fallback dance. `enabled` controls whether the query fires — the
 * sub-pages gate this on `useAuth().isAuthenticated`.
 */
export function useInsightsLayoutPrefs(enabled: boolean) {
  const { data } = useQuery({
    queryKey: queryKeys.dashboardWidgets(),
    queryFn: async () => {
      const res = await fetch("/api/dashboard/widgets");
      if (!res.ok) throw new Error("Failed to load dashboard layout");
      const json = await res.json();
      return json.data as DashboardLayout;
    },
    enabled,
  });
  const compareBaseline =
    resolveDashboardLayout(data).comparisonBaseline ?? "none";
  return { layout: data ?? null, compareBaseline } as const;
}
