"use client";

/**
 * Client-side feature-flag context — exposes admin-managed app settings to
 * layout components so nav surfaces can hide entries when the admin flips a
 * toggle.
 *
 * Today this only carries the `bugReportEnabled` flag (the "Bug Report"
 * sidebar entry, the bottom-nav, the topbar dropdown, and the user-facing
 * "Report bug" buttons inside `<ErrorDetails>` all gate on it). Add new
 * flags here when more admin-managed feature toggles need to reach the
 * client.
 *
 * Source: `GET /api/bugreport/status` already returns `{ enabled }` for any
 * authenticated user. We piggy-back on that endpoint instead of standing up
 * a parallel `/api/app-settings` route — the data is identical and the
 * caching / rate-limit story is already solved upstream.
 *
 * Defaults to "all flags ON" so unauthenticated layouts (login, register)
 * and the brief window before the query resolves don't flicker the entry
 * out from underneath the user. The admin's "off" state only takes effect
 * once the data has actually arrived.
 */

import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";

export interface AppSettings {
  /** Whether the admin has enabled in-app bug-report / feedback submission. */
  bugReportEnabled: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  bugReportEnabled: true,
};

const AppSettingsContext = createContext<AppSettings>(DEFAULT_SETTINGS);

export function useAppSettings(): AppSettings {
  return useContext(AppSettingsContext);
}

interface BugReportStatusPayload {
  configured: boolean;
  enabled: boolean;
  isAdmin: boolean;
}

/**
 * Fetches `bugReportEnabled` once per session and exposes it via context. The
 * provider lives inside `Providers` so anything beneath the React tree —
 * including the global nav surfaces — can observe the flag without
 * each component re-fetching the same status payload.
 */
export function AppSettingsProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const { data } = useQuery({
    queryKey: queryKeys.bugreportStatus(),
    enabled: isAuthenticated,
    queryFn: async () => {
      return apiGet<BugReportStatusPayload>("/api/bugreport/status");
    },
    staleTime: 5 * 60 * 1000,
  });

  // Default to ON when the query is still loading, has errored, or the user
  // is unauthenticated — the nav must not flicker the entry out under the
  // user's cursor on a slow network.
  const settings: AppSettings = {
    bugReportEnabled: data?.enabled ?? true,
  };

  return (
    <AppSettingsContext.Provider value={settings}>
      {children}
    </AppSettingsContext.Provider>
  );
}
