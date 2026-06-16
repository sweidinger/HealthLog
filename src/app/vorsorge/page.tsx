"use client";

import { useCallback } from "react";
import { Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { PullToRefreshIndicator } from "@/components/ui/pull-to-refresh-indicator";
import { VorsorgeSection } from "@/components/measurement-reminders/vorsorge-section";
import { queryKeys } from "@/lib/query-keys";

/**
 * v1.17.1 — Vorsorge (preventive-care) reminders page. The dedicated
 * feature surface for "wann muss ich was wo machen". Auth-gated; the
 * section component owns the list + create flow.
 *
 * v1.18.1 — pull-to-refresh parity with every peer page (labs, mood,
 * measurements): a pull invalidates the measurement-reminders read so the
 * list + server-computed next-due repaint.
 */
export default function VorsorgePage() {
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
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PullToRefreshIndicator {...pull} />
      <VorsorgeSection enabled={isAuthenticated} variant="page" />
    </div>
  );
}
