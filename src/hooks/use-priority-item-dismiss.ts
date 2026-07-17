"use client";

/**
 * Today rail — "dismiss / mark seen" for the OBSERVATIONAL `PriorityItem`
 * kinds (`milestone`, `ecg_new_recording`, `tension_window`). Posts the
 * item's own `itemKey` to `POST /api/daily/digest/dismiss` (server persists
 * it so the dismissal survives reload / a second device), then invalidates
 * the daily digest so the dismissed card leaves the rail immediately — the
 * same invalidate-on-mutate pattern `useCoachCheckinAction` uses. Keys route
 * through the centralised factory — no bare arrays.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiPost } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

export function usePriorityItemDismiss() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (itemKey: string) => {
      await apiPost("/api/daily/digest/dismiss", { itemKey });
      return itemKey;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.dailyDigest() });
    },
  });
}
