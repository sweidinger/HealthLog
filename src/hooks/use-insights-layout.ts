"use client";

import { useQuery } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";
import {
  DEFAULT_INSIGHTS_LAYOUT,
  resolveInsightsLayout,
  type InsightsLayout,
} from "@/lib/insights-layout";

/**
 * v1.15.11 W2 — the resolved insights overview layout (sections + tiles).
 *
 * Reads `GET /api/insights/layout` through the centralised query-key factory
 * (`queryKeys.insightsLayout()` → `["user","insightsLayout"]`), the same key
 * the W3 PUT mutation invalidates on save so the overview repaints in
 * lockstep with the Settings / inline-edit surfaces. The response is already
 * the server-resolved v2 layout; we pass it back through
 * `resolveInsightsLayout` defensively so a partial / legacy blob from a stale
 * cache still normalises to a valid `InsightsLayout`.
 *
 * Returns `DEFAULT_INSIGHTS_LAYOUT` while the query is in-flight so the page
 * renders in the default section + tile order on first paint — no layout
 * flicker, no empty state, no "everything hidden" flash before the saved
 * layout lands.
 */
export function useInsightsLayout(enabled: boolean): InsightsLayout {
  const { data } = useQuery({
    queryKey: queryKeys.insightsLayout(),
    queryFn: async () => {
      const res = await fetch("/api/insights/layout");
      if (!res.ok) throw new Error("Failed to load insights layout");
      return resolveInsightsLayout((await res.json()).data);
    },
    enabled,
  });
  return data ?? DEFAULT_INSIGHTS_LAYOUT;
}
