"use client";

import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  DEFAULT_CHART_OVERLAY_PREFS,
  type ChartOverlayKey,
  type ChartOverlayPrefs,
  type ChartOverlayPrefsMap,
  type DashboardLayout,
} from "@/lib/dashboard-layout";

/**
 * v1.4.18 — TanStack Query hook that returns a single chart's overlay
 * prefs and a setter that persists them via the new
 * `PUT /api/dashboard/chart-overlay-prefs` endpoint.
 *
 * Reads from the existing dashboard-widgets cache (queryKey
 * `["dashboard-layout"]`) so a chart on the dashboard doesn't fire a
 * second network request — the layout already lands once on initial
 * dashboard render.
 *
 * The mutation is optimistic: we update the cached layout immediately
 * so the chart re-renders with the new toggle state before the network
 * round-trip resolves. On error the cache is rolled back to its
 * previous value.
 */
export function useChartOverlayPrefs(chartKey: ChartOverlayKey): {
  prefs: ChartOverlayPrefs;
  setPrefs: (next: ChartOverlayPrefs) => void;
  isSaving: boolean;
} {
  const queryClient = useQueryClient();

  const { data: layout } = useQuery({
    queryKey: ["dashboard-layout"],
    queryFn: async (): Promise<DashboardLayout> => {
      const res = await fetch("/api/dashboard/widgets");
      if (!res.ok) throw new Error("Failed to load dashboard layout");
      const json = await res.json();
      return json.data as DashboardLayout;
    },
    // Keep the cache warm — the dashboard page mounts a query against
    // the same key on first paint, so this hook just piggy-backs.
    staleTime: 60_000,
  });

  const prefs = useMemo<ChartOverlayPrefs>(() => {
    return (
      layout?.chartOverlayPrefs?.[chartKey] ?? DEFAULT_CHART_OVERLAY_PREFS
    );
  }, [layout, chartKey]);

  const mutation = useMutation({
    mutationFn: async (next: ChartOverlayPrefs): Promise<void> => {
      const res = await fetch("/api/dashboard/chart-overlay-prefs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chartKey, prefs: next }),
      });
      if (!res.ok) {
        throw new Error("Failed to save chart overlay prefs");
      }
    },
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: ["dashboard-layout"] });
      const previous = queryClient.getQueryData<DashboardLayout>([
        "dashboard-layout",
      ]);
      if (previous) {
        const nextLayout: DashboardLayout = {
          ...previous,
          chartOverlayPrefs: {
            ...(previous.chartOverlayPrefs ?? {}),
            [chartKey]: next,
          } as ChartOverlayPrefsMap,
        };
        queryClient.setQueryData(["dashboard-layout"], nextLayout);
      }
      return { previous };
    },
    onError: (_err, _next, ctx) => {
      const context = ctx as { previous?: DashboardLayout } | undefined;
      if (context?.previous) {
        queryClient.setQueryData(["dashboard-layout"], context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["dashboard-layout"] });
    },
  });

  const setPrefs = useCallback(
    (next: ChartOverlayPrefs): void => {
      mutation.mutate(next);
    },
    [mutation],
  );

  return {
    prefs,
    setPrefs,
    isSaving: mutation.isPending,
  };
}
