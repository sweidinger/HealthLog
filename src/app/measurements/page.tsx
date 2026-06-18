"use client";

import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import {
  MeasurementForm,
  resolveAddToken,
} from "@/components/measurements/measurement-form";
import { MeasurementList } from "@/components/measurements/measurement-list";
import { Button } from "@/components/ui/button";
import { PullToRefreshIndicator } from "@/components/ui/pull-to-refresh-indicator";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Plus, Loader2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "@/lib/i18n/context";
import { ModuleTourTrigger } from "@/components/onboarding/module-tour-trigger";

export default function MeasurementsPage() {
  const { isAuthenticated, isLoading } = useAuth();
  const mounted = useMounted();
  const router = useRouter();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const { t } = useTranslations();

  // v1.4.27 MB6 — read the `?add=<TYPE>` query param during render so
  // the dialog opens on the first paint (no flash of the page behind
  // it). The first-load param is consumed in the `useState` lazy
  // initializers: they run identically on the server and the hydration
  // render (pure token resolution, no router call), so SSR — which sees
  // real search params now that the root layout renders every route
  // dynamically — stays side-effect free. Calling `router.replace`
  // during a server render throws (`location is not defined`); the
  // query-strip lives in the effect below instead. The render-driven
  // block then only handles LATER client-side navigations back to
  // `?add=` (e.g. the insights empty-state CTAs), following the
  // state-from-prop pattern in `account-section.tsx` — the lint rule
  // `react-hooks/set-state-in-effect` rejects setState from inside an
  // effect, so that path stays render-driven.
  const addParam = searchParams.get("add");
  const initialAdd = addParam ? resolveAddToken(addParam) : null;
  const [dialogOpen, setDialogOpen] = useState(() => initialAdd != null);
  const [defaultType, setDefaultType] = useState<string | undefined>(
    () => initialAdd ?? undefined,
  );
  const [consumedAddParam, setConsumedAddParam] = useState<string | null>(
    () => addParam,
  );
  // v1.4.27 R4 RC2 — DOM handle the form portals its action row into so
  // the Sheet branch can sticky-pin Save / Cancel.
  const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);

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

  // Later client-side navigation landed on `?add=` again (the first
  // load is consumed by the initializers above, so on the server this
  // is always a no-op: `consumedAddParam` starts as the param itself).
  if (addParam && addParam !== consumedAddParam) {
    setConsumedAddParam(addParam);
    // v1.4.34 IW-G — `resolveAddToken` is the single source of truth
    // for legacy aliases (`GLUCOSE`, `TEMPERATURE`, …) plus the
    // canonical form values. Unknown tokens still drop silently so a
    // stale link cannot trap the user on a broken form.
    const resolved = resolveAddToken(addParam);
    if (resolved) {
      setDefaultType(resolved);
      setDialogOpen(true);
    }
  }

  // Drop the query string so the back-button leaves the user on
  // `/measurements` rather than re-opening the dialog. Effect-driven
  // (client-only) because `router.replace` is not callable during SSR.
  useEffect(() => {
    if (addParam) router.replace("/measurements");
  }, [addParam, router]);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push("/auth/login");
    }
  }, [isLoading, isAuthenticated, router]);

  // v1.16.4 — `!mounted` keeps the hydration render identical to the
  // SSR HTML when this boundary hydrates after `/api/auth/me` settled
  // (React #418 family); see `useMounted`.
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
        <div className="min-w-0">
          <h1
            data-tour-id="measurements-hero"
            className="text-2xl font-bold tracking-tight"
          >
            {t("measurements.title")}
          </h1>
          {/* v1.4.34 IW-G — subtitle now stays visible on mobile so
              the H1 isn't an unframed label. `text-xs sm:text-sm`
              preserves the desktop hierarchy. */}
          <p className="text-muted-foreground truncate text-xs sm:text-sm">
            {t("measurements.subtitle")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ModuleTourTrigger stopId="measurements" />
          <Button
            className="min-h-11 sm:min-h-9"
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="h-4 w-4" />
            {t("measurements.addMeasurement")}
          </Button>
        </div>
      </div>

      <ResponsiveSheet
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setDefaultType(undefined);
        }}
        title={t("measurements.addMeasurement")}
        footer={<div ref={setFooterEl} className="flex w-full" />}
      >
        <MeasurementForm
          defaultType={defaultType}
          onSuccess={() => {
            setDialogOpen(false);
            setDefaultType(undefined);
          }}
          onCancel={() => {
            setDialogOpen(false);
            setDefaultType(undefined);
          }}
          footerSlot={footerEl}
        />
      </ResponsiveSheet>

      <MeasurementList onAddFirst={() => setDialogOpen(true)} />
    </div>
  );
}
