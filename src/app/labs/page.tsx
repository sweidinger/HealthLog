"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Loader2, Plus } from "lucide-react";

import { BiomarkerManager } from "@/components/labs/biomarker-manager";
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
  const [manageOpen, setManageOpen] = useState(false);

  const refreshVisible = useCallback(
    () => queryClient.invalidateQueries({ type: "active" }),
    [queryClient],
  );
  const pull = usePullToRefresh({
    onRefresh: refreshVisible,
    disabled: dialogOpen || manageOpen,
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
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            onClick={() => setManageOpen(true)}
            className="min-h-11 sm:min-h-9"
          >
            <FlaskConical className="h-4 w-4" />
            <span className="hidden sm:inline">
              {t("labs.biomarker.manage")}
            </span>
          </Button>
          <Button
            onClick={() => setDialogOpen(true)}
            className="min-h-11 sm:min-h-9"
          >
            <Plus className="h-4 w-4" />
            {t("labs.addResult")}
          </Button>
        </div>
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

      <ResponsiveSheet
        open={manageOpen}
        onOpenChange={setManageOpen}
        title={t("labs.biomarker.manageTitle")}
        description={t("labs.biomarker.manageSheetDescription")}
      >
        <BiomarkerManager />
      </ResponsiveSheet>

      <LabList onAddFirst={() => setDialogOpen(true)} />
    </div>
  );
}
