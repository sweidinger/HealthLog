"use client";

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { PullToRefreshIndicator } from "@/components/ui/pull-to-refresh-indicator";
import { PageAuthGate } from "@/components/ui/page-auth-gate";
import { VorsorgeSection } from "@/components/measurement-reminders/vorsorge-section";
import { queryKeys } from "@/lib/query-keys";

/**
 * v1.17.1 — Checkups (preventive-care) reminders page. The dedicated
 * feature surface for "wann muss ich was wo machen". Auth-gated; the
 * section component owns the list + create flow.
 *
 * v1.18.1 — pull-to-refresh parity with every peer page (labs, mood,
 * measurements): a pull invalidates the measurement-reminders read so the
 * list + server-computed next-due repaint.
 */
export default function CheckupsPage() {
  const { isAuthenticated, isLoading } = useAuth();
  const mounted = useMounted();
  const queryClient = useQueryClient();

  const refresh = useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.measurementReminders(),
      }),
    [queryClient],
  );
  const pull = usePullToRefresh({ onRefresh: refresh });

  if (!mounted || isLoading) {
    return <PageAuthGate />;
  }

  return (
    <div className="space-y-6">
      <PullToRefreshIndicator {...pull} />
      <VorsorgeSection enabled={isAuthenticated} variant="page" />
    </div>
  );
}
