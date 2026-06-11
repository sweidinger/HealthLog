"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import type { ComplianceDisplay } from "@/lib/analytics/compliance";

/**
 * One batched-summary row — the compact slice of the per-medication
 * compliance payload the cards render (rates, streak, the cadence-scaled
 * display block with `currentDose` / `currentCycle`). The heavy
 * `dailyCompliance` heatmap stays on the per-id endpoint the detail page
 * reads.
 */
export interface MedicationComplianceSummaryEntry {
  medicationId: string;
  compliance7: { rate: number; streak: number };
  compliance30: { rate: number };
  complianceDisplay?: ComplianceDisplay;
}

/**
 * v1.16.8 — the per-card compliance read, batched.
 *
 * Every medication card used to fire its own
 * `GET /api/medications/{id}/compliance` (N+1 over the grid, ~1 s cold
 * each). All cards now share ONE `GET /api/medications/compliance`
 * round trip under a single query key; each card `select`s its own row,
 * so a grid of mounted cards collapses into one request and one cache
 * entry. The key rides the `["medications"]` prefix, so every intake /
 * CRUD mutation that invalidates `medicationDependentKeys` refreshes it.
 *
 * Lives in one shared hook (not per-card `useQuery` calls) so the two
 * card variants can never register the same key with diverging fetch
 * shapes.
 */
export function useMedicationComplianceSummary(medicationId: string): {
  data: MedicationComplianceSummaryEntry | null | undefined;
} {
  const { data } = useQuery({
    queryKey: queryKeys.medicationComplianceSummary(),
    queryFn: async () => {
      try {
        return await apiGet<MedicationComplianceSummaryEntry[]>(
          "/api/medications/compliance",
        );
      } catch {
        return null;
      }
    },
    // Dose actions invalidate the key explicitly through
    // `medicationDependentKeys`; a shorter window would only re-fire the
    // batch on every list visit. Matches the reminder-thresholds query
    // the cards mount alongside.
    staleTime: 5 * 60 * 1000,
    select: (rows: MedicationComplianceSummaryEntry[] | null) =>
      rows?.find((row) => row.medicationId === medicationId) ?? null,
  });
  return { data };
}
