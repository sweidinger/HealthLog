"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";

import { LabForm } from "@/components/labs/lab-form";
import { LabList } from "@/components/labs/lab-list";
import { Button } from "@/components/ui/button";
import { PullToRefreshIndicator } from "@/components/ui/pull-to-refresh-indicator";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

export default function LabsPage() {
  const { isAuthenticated, isLoading } = useAuth();
  const mounted = useMounted();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { t } = useTranslations();
  const [dialogOpen, setDialogOpen] = useState(false);

  const refreshVisible = useCallback(
    () => queryClient.invalidateQueries({ type: "active" }),
    [queryClient],
  );
  const pull = usePullToRefresh({
    onRefresh: refreshVisible,
    disabled: dialogOpen,
  });

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push("/auth/login");
    }
  }, [isLoading, isAuthenticated, router]);

  if (!mounted || isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PullToRefreshIndicator {...pull} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">
            {t("labs.title")}
          </h1>
          <p className="text-muted-foreground text-xs sm:text-sm">
            {t("labs.subtitle")}
          </p>
        </div>
        <Button
          onClick={() => setDialogOpen(true)}
          className="min-h-11 shrink-0 sm:min-h-9"
        >
          <Plus className="h-4 w-4" />
          {t("labs.addResult")}
        </Button>
      </div>

      <ResponsiveSheet
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={t("labs.addResult")}
        description={t("labs.addDescription")}
      >
        <LabForm
          onSuccess={() => {
            setDialogOpen(false);
            queryClient.invalidateQueries({
              queryKey: queryKeys.labResults(),
            });
          }}
          onCancel={() => setDialogOpen(false)}
        />
      </ResponsiveSheet>

      <LabList onAddFirst={() => setDialogOpen(true)} />
    </div>
  );
}
