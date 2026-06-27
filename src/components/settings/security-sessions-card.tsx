"use client";

/**
 * v1.23 — Settings → account → "Active sessions" (issue #64).
 *
 * Lists the user's active web sessions (device label, masked IP, resolved
 * location, last-active time, current-device marker) and offers a per-session
 * "sign out" plus a "sign out everywhere else" that revokes every other
 * session (and native device logins) while keeping the current one. All reads
 * + writes route through the centralised query-key factory.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, MonitorSmartphone } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiGet, apiDelete } from "@/lib/api/api-fetch";

interface SessionRow {
  id: string;
  device: string;
  ipMasked: string | null;
  location: string | null;
  lastActiveAt: string | null;
  createdAt: string;
  isCurrent: boolean;
}

export function SecuritySessionsCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.sessions(),
    queryFn: () => apiGet<{ sessions: SessionRow[] }>("/api/auth/me/sessions"),
    enabled: isAuthenticated,
  });

  const revokeOne = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/auth/me/sessions/${id}`),
    onSuccess: () => {
      setStatus(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions() });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.securityActivity(),
      });
    },
    onError: () => setStatus(t("settings.security.revokeError")),
  });

  const revokeOthers = useMutation({
    mutationFn: () =>
      apiDelete<{ sessionsRevoked: number }>("/api/auth/me/sessions"),
    onSuccess: (res) => {
      setStatus(
        t("settings.security.signOutEverywhereDone", {
          count: res?.sessionsRevoked ?? 0,
        }),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions() });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.securityActivity(),
      });
    },
    onError: () => setStatus(t("settings.security.revokeError")),
  });

  const sessions = data?.sessions ?? [];
  const hasOthers = sessions.some((s) => !s.isCurrent);

  return (
    <SettingsCard data-slot="settings-security-sessions-card">
      <SettingsCardHeader
        icon={MonitorSmartphone}
        title={t("settings.security.sessionsTitle")}
        className="mb-4"
      />
      <div className="space-y-4 pl-7">
        <p className="text-muted-foreground text-xs">
          {t("settings.security.sessionsDescription")}
        </p>

        {isLoading && (
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin motion-reduce:animate-none" />
        )}

        {isError && (
          <p role="alert" className="text-destructive text-sm">
            {t("settings.security.sessionsLoadError")}
          </p>
        )}

        {!isLoading && !isError && sessions.length === 0 && (
          <p className="text-muted-foreground text-sm">
            {t("settings.security.sessionsEmpty")}
          </p>
        )}

        {sessions.length > 0 && (
          <ul className="divide-border divide-y">
            {sessions.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-3 py-3"
                data-slot="security-session-row"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-sm font-medium">
                    {s.device}
                    {s.isCurrent && (
                      <span className="text-success ml-2 text-xs font-normal">
                        {t("settings.security.currentSession")}
                      </span>
                    )}
                  </p>
                  <p className="text-muted-foreground truncate text-xs">
                    {[
                      s.location ?? t("settings.security.unknownLocation"),
                      s.ipMasked,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {s.lastActiveAt && (
                    <p className="text-muted-foreground text-xs">
                      {t("settings.security.lastActive", {
                        time: new Date(s.lastActiveAt).toLocaleString(),
                      })}
                    </p>
                  )}
                </div>
                {!s.isCurrent && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-9 shrink-0"
                    onClick={() => revokeOne.mutate(s.id)}
                    disabled={revokeOne.isPending}
                  >
                    {t("settings.security.revokeSession")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {hasOthers && (
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 sm:min-h-9"
              onClick={() => revokeOthers.mutate()}
              disabled={revokeOthers.isPending}
            >
              {revokeOthers.isPending && (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              )}
              {t("settings.security.signOutEverywhere")}
            </Button>
          </div>
        )}

        {status && (
          <p role="status" className="text-muted-foreground text-right text-sm">
            {status}
          </p>
        )}
      </div>
    </SettingsCard>
  );
}
