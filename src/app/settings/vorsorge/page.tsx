"use client";

import { Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";
import { ModuleSettingsFrame } from "@/components/module-list/module-settings-frame";
import { VorsorgeSettings } from "@/components/measurement-reminders/vorsorge-settings";

/**
 * v1.18.6 (W8 / MOD-03) — the Vorsorge module's own settings page.
 *
 * A dedicated static route that wins over the dynamic `/settings/[section]`
 * router (static segments take precedence in Next.js), so it adds a
 * per-module settings surface without touching the parallel-phase-owned
 * `section-slugs` registry or `settings-shell`. Reached from the wrench
 * beside the Vorsorge page's "hinzufügen" button.
 */
export default function VorsorgeSettingsPage() {
  const { isLoading } = useAuth();
  const mounted = useMounted();
  const { t } = useTranslations();

  if (!mounted || isLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  return (
    <ModuleSettingsFrame
      title={t("measurementReminders.settings.title")}
      description={t("measurementReminders.settings.description")}
      backHref="/vorsorge"
      backLabelKey="measurementReminders.settings.back"
    >
      <VorsorgeSettings />
    </ModuleSettingsFrame>
  );
}
