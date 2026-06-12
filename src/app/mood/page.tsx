"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { MoodForm } from "@/components/mood/mood-form";
import { MoodList } from "@/components/mood/mood-list";
import { Button } from "@/components/ui/button";
import { PullToRefreshIndicator } from "@/components/ui/pull-to-refresh-indicator";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Plus, Loader2, Wrench } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useTranslations } from "@/lib/i18n/context";

export default function MoodPage() {
  const { isAuthenticated, isLoading } = useAuth();
  const mounted = useMounted();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  // v1.4.27 R4 RC2 — DOM-ref handle the form portals its action row
  // into. The ref lives on the `<ResponsiveSheet>` footer slot so the
  // Sheet branch can sticky-pin Save / Cancel above the keyboard.
  const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);
  const { t } = useTranslations();

  // v1.16.4 — PWA pull-to-refresh: a top-anchored touch pull refetches
  // whatever this page currently has mounted (`type: "active"` scopes the
  // invalidation to visible queries). Suspended while the add-sheet is
  // open so a drag inside the form can't arm the gesture.
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

  // `!mounted` keeps the hydration render identical to the SSR HTML: the
  // auth query is fired by the early-hydrating shell and can settle before
  // this page boundary hydrates, so `isLoading` alone flipped the branch
  // and React logged hydration error #418 — same fix as the measurements
  // page; see `useMounted`.
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {t("mood.title")}
          </h1>
          {/* v1.4.34 IW-G — subtitle stays visible on mobile so the
              H1 isn't an unframed label. */}
          <p className="text-muted-foreground text-xs sm:text-sm">
            {t("mood.subtitle")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* v1.17 — the wrench is the one customize entry point: it
              links to /settings/mood, which owns the tag groups, custom
              tags, visibility, and picker order. Same glyph, slot (left
              of the add button) and responsive 44-px mobile tap floor
              as the medications header. */}
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
          >
            <Link
              href="/settings/mood"
              aria-label={t("mood.customize")}
              title={t("mood.customize")}
            >
              <Wrench className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
          <Button
            onClick={() => setDialogOpen(true)}
            className="min-h-11 sm:min-h-9"
          >
            <Plus className="h-4 w-4" />
            {t("mood.addEntry")}
          </Button>
        </div>
      </div>

      <ResponsiveSheet
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={t("mood.addEntry")}
        footer={<div ref={setFooterEl} className="flex w-full" />}
      >
        <MoodForm
          onSuccess={() => setDialogOpen(false)}
          onCancel={() => setDialogOpen(false)}
          footerSlot={footerEl}
        />
      </ResponsiveSheet>

      <MoodList onAddFirst={() => setDialogOpen(true)} />
    </div>
  );
}
