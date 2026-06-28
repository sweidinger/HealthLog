"use client";

import { useQuery } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { useAuth } from "@/hooks/use-auth";

/**
 * v1.25.0 — the single client-side gate for proactive ambient Coach
 * SUGGESTIONS (today: the daily seeded example opener on the Coach hero).
 *
 * Reads the per-user opt-out from the shared notification-prefs blob
 * (`coach.ambientSuggestions`). Default ON: an unauthenticated read, a
 * still-loading query, or a missing field all resolve to `true` so the
 * suggestions show out of the box and only hide once the user explicitly turns
 * them off in Settings. Shares the `authNotificationPrefs` query key with the
 * settings card, so toggling the switch there flips this read in lockstep.
 */
interface AmbientSuggestionsPrefsShape {
  coach?: { ambientSuggestions?: boolean };
}

export function useCoachAmbientSuggestionsEnabled(): boolean {
  const { isAuthenticated } = useAuth();
  const { data } = useQuery({
    queryKey: queryKeys.authNotificationPrefs(),
    queryFn: async () =>
      apiGet<AmbientSuggestionsPrefsShape>("/api/auth/me/notification-prefs"),
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000,
  });
  return data?.coach?.ambientSuggestions ?? true;
}
