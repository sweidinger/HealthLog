"use client";

import { Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";
import { ModuleSettingsFrame } from "@/components/module-list/module-settings-frame";
import { LabsSettings } from "@/components/labs/labs-settings";

/**
 * v1.18.6 (W8 / MOD-03 + MOD-04) — the Labs module's own settings page.
 * Dedicated static route (wins over `/settings/[section]`); reached from the
 * wrench beside the Labs page's "hinzufügen" button.
 */
export default function LabsSettingsPage() {
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
      title={t("labs.settings.title")}
      description={t("labs.settings.description")}
      backHref="/labs"
      backLabelKey="labs.settings.back"
    >
      <LabsSettings />
    </ModuleSettingsFrame>
  );
}
