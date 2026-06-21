"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { CalendarHeart, Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiGet, apiPatch } from "@/lib/api/api-fetch";

/**
 * v1.15.0 — the cycle-tracking enable on-ramp.
 *
 * The cycle vertical auto-enables for accounts set to female (gender-derived
 * default), but everyone else needs a way IN: the gated `/cycle` page bounces
 * them home and the in-page settings (where the goal/prefs live) sit behind
 * that same gate. This card reads the UNGATED `/api/auth/me/cycle-prefs` so any
 * account can flip `cycleTrackingEnabled` on (or a female account can opt out)
 * before the gated page is reachable. PATCHes the same prefs route the iOS app
 * uses; invalidates the nav gate so the sidebar/bottom-nav entry appears.
 */

interface CyclePrefsShape {
  cycleTrackingEnabled: boolean;
}

export function CycleTrackingCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: queryKeys.cyclePrefs(),
    enabled: isAuthenticated,
    queryFn: async () => {
      return apiGet<CyclePrefsShape>("/api/auth/me/cycle-prefs");
    },
  });

  const toggle = useMutation({
    mutationFn: async (enabled: boolean) => {
      return apiPatch<CyclePrefsShape>("/api/auth/me/cycle-prefs", { enabled });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.cyclePrefs() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.cycle() });
      // The nav gate reads the resolved enable state off /auth/me.
      void queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
    },
  });

  const enabled = data?.cycleTrackingEnabled ?? false;

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={CalendarHeart}
        title={t("settings.cycleTracking.title")}
        description={t("settings.cycleTracking.description")}
      />
      <div className="mt-4 space-y-4 pl-7">
        <div className="flex items-start justify-between gap-4">
          <Label htmlFor="cycle-tracking-enable" className="text-sm">
            {t("settings.cycleTracking.enable")}
          </Label>
          <Switch
            id="cycle-tracking-enable"
            checked={enabled}
            disabled={toggle.isPending || data == null}
            onCheckedChange={(v) => toggle.mutate(v)}
            className="mt-0.5 shrink-0"
          />
        </div>
        {/* The single, prominent non-medical disclaimer for the whole cycle
            vertical. It lives here at the on-ramp — where expectations are
            set — instead of repeating beneath every prediction surface. */}
        <div
          data-slot="cycle-tracking-disclaimer"
          className="border-border bg-muted/40 flex items-start gap-2.5 rounded-lg border-l-2 p-3"
        >
          <Info
            className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0"
            aria-hidden="true"
          />
          <p className="text-foreground/80 text-xs leading-relaxed">
            {t("settings.cycleTracking.disclaimer")}
          </p>
        </div>
        {enabled ? (
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            asChild
          >
            <Link href="/cycle">{t("settings.cycleTracking.manage")}</Link>
          </Button>
        ) : null}
        {toggle.isError ? (
          <p className="text-destructive text-sm" role="alert">
            {t("settings.cycleTracking.error")}
          </p>
        ) : null}
      </div>
    </SettingsCard>
  );
}
