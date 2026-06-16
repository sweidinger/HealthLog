"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Loader2, MoreVertical, Plus } from "lucide-react";

import { BiomarkerManager } from "@/components/labs/biomarker-manager";
import { LabForm } from "@/components/labs/lab-form";
import { LabList } from "@/components/labs/lab-list";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  // Sticky-footer slot element for the add-result sheet (filled by the
  // ResponsiveSheet `footer` ref so the form portals its action row there).
  const [addFooterEl, setAddFooterEl] = useState<HTMLDivElement | null>(null);

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
        <div className="flex shrink-0 items-center gap-2">
          <Button
            onClick={() => setDialogOpen(true)}
            className="min-h-11 sm:min-h-9"
          >
            <Plus className="h-4 w-4" />
            {t("labs.addResult")}
          </Button>
          {/* Secondary actions fold into one overflow kebab beside the primary
              Add, mirroring the medication-card header (one cluster, not a
              two-button row). */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
                aria-label={t("common.moreOptions")}
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={() => setManageOpen(true)}>
                <FlaskConical className="mr-2 h-4 w-4" />
                {t("labs.biomarker.manage")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <ResponsiveSheet
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={t("labs.addResult")}
        description={t("labs.addDescription")}
        footer={<div ref={setAddFooterEl} className="flex w-full justify-end gap-2" />}
      >
        <LabForm
          footerSlot={addFooterEl}
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
