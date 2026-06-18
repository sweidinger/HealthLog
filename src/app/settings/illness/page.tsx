"use client";

import { Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";
import { ModuleSettingsFrame } from "@/components/module-list/module-settings-frame";
import { IllnessSettings } from "@/components/illness/illness-settings";

/**
 * v1.18.6 (W8 / MOD-03) — the Illness module's own settings page. Dedicated
 * static route (wins over `/settings/[section]`); reached from the wrench
 * beside the Illness page's "hinzufügen" button.
 */
export default function IllnessSettingsPage() {
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
      title={t("illness.settings.title")}
      description={t("illness.settings.description")}
      backHref="/illness"
      backLabelKey="illness.settings.back"
    >
      <IllnessSettings />
    </ModuleSettingsFrame>
  );
}
