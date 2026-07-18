"use client";

/**
 * Today rail — "dismiss / mark seen" for the OBSERVATIONAL `PriorityItem`
 * kinds (`milestone`, `ecg_new_recording`, `tension_window`). Posts the
 * item's own `itemKey` to `POST /api/daily/digest/dismiss` (server persists
 * it so the dismissal survives reload / a second device). Keys route
 * through the centralised factory — no bare arrays.
 *
 * The dismiss is optimistic (`onMutate` strikes the item from the cached
 * digest immediately): a second tap on the same card has nothing left to
 * hit, since the card itself leaves the rail before the round trip lands.
 * `onError` rolls the cache back to the pre-tap snapshot; `onSettled`
 * re-syncs from the server either way.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiPost } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import type { DailyDigest } from "@/lib/daily/digest";

export function usePriorityItemDismiss() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (itemKey: string) => {
      await apiPost("/api/daily/digest/dismiss", { itemKey });
      return itemKey;
    },
    onMutate: async (itemKey) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.dailyDigest() });
      const previous = queryClient.getQueryData<DailyDigest>(
        queryKeys.dailyDigest(),
      );
      if (previous) {
        queryClient.setQueryData<DailyDigest>(queryKeys.dailyDigest(), {
          ...previous,
          worthALook: previous.worthALook.filter(
            (item) => item.itemKey !== itemKey,
          ),
        });
      }
      return { previous };
    },
    onError: (_err, _itemKey, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.dailyDigest(), context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.dailyDigest() });
    },
  });
}
