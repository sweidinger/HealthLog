"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, ScanLine, Wrench } from "lucide-react";

import { LabForm } from "@/components/labs/lab-form";
import { LabList } from "@/components/labs/lab-list";
import { OcrReviewDialog } from "@/components/labs/ocr-review-dialog";
import { useOcrCapability } from "@/components/labs/use-ocr-extract";
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
  // Sticky-footer slot element for the add-result sheet (filled by the
  // ResponsiveSheet `footer` ref so the form portals its action row there).
  const [addFooterEl, setAddFooterEl] = useState<HTMLDivElement | null>(null);
  // v1.18.9 — Lab-OCR "Scan a report" dialog. The scan affordance only shows
  // when the user's configured AI provider can read images (capability probe).
  const [scanOpen, setScanOpen] = useState(false);
  const ocrCapability = useOcrCapability(isAuthenticated);

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
          <h1
            data-tour-id="labs-hero"
            className="text-2xl font-bold tracking-tight"
          >
            {t("labs.title")}
          </h1>
          <p className="text-muted-foreground text-xs sm:text-sm">
            {t("labs.subtitle")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* v1.18.9 — "Scan a report" Lab-OCR entry. Shown only when the
              capability probe reports a vision-capable provider is configured,
              so the surface stays dark for codex-only / text-only-model users. */}
          {ocrCapability.data?.available ? (
            <Button
              variant="outline"
              onClick={() => setScanOpen(true)}
              className="min-h-11 sm:min-h-9"
            >
              <ScanLine className="h-4 w-4" />
              {t("labs.ocr.scanButton")}
            </Button>
          ) : null}
          {/* v1.18.6 (MOD-01) — the wrench is the module's customize entry
              point, left of the primary Add and linking to the Labs settings
              page (view, sort order, biomarker CRUD + reorder). Mirrors the
              medication page header's wrench glyph + slot + 44px tap floor. */}
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
          >
            <Link
              href="/settings/labs"
              aria-label={t("labs.customize")}
              title={t("labs.customize")}
            >
              <Wrench className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
          <Button
            onClick={() => setDialogOpen(true)}
            className="min-h-11 sm:min-h-9"
          >
            <Plus className="h-4 w-4" />
            {t("common.add")}
          </Button>
        </div>
      </div>

      <ResponsiveSheet
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={t("labs.addResult")}
        description={t("labs.addDescription")}
        footer={
          <div ref={setAddFooterEl} className="flex w-full justify-end gap-2" />
        }
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

      {ocrCapability.data?.available ? (
        <OcrReviewDialog
          open={scanOpen}
          onOpenChange={setScanOpen}
          pdfSupported={ocrCapability.data.pdfSupported}
          onCommitted={() => {
            queryClient.invalidateQueries({
              queryKey: queryKeys.labResults(),
            });
            queryClient.invalidateQueries({
              queryKey: queryKeys.biomarkers(),
            });
          }}
        />
      ) : null}

      <LabList onAddFirst={() => setDialogOpen(true)} />
    </div>
  );
}
