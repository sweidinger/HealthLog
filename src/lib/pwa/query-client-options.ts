import type { DefaultOptions } from "@tanstack/react-query";

/**
 * Shared TanStack Query default options for the app's single `QueryClient`.
 * Extracted from `providers.tsx` so the offline-mutation contract (F-OFF-1) is
 * unit-testable without importing the whole client-component tree.
 *
 * Mutations run in `always` network mode. The library default (`online`) PAUSES
 * a mutation fired offline — `isPending` stays true forever, `onError` never
 * fires, and the paused mutation is silently DROPPED on reload, so a health
 * entry vanishes with no "not saved" signal. In `always` mode the mutation runs
 * regardless, the offline `fetch` rejects immediately, and `onError` fires — an
 * honest failure the form surfaces (and the global `OfflineMutationToaster`
 * backstops), instead of a spinner-of-death plus silent write loss.
 */
export const QUERY_CLIENT_DEFAULT_OPTIONS: DefaultOptions = {
  queries: {
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  },
  mutations: {
    networkMode: "always",
  },
};
