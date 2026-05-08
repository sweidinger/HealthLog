"use client";

import { ThresholdsSection } from "@/components/settings/thresholds-section";
import { useTranslations } from "@/lib/i18n/context";

export function ThresholdsSettingsSection() {
  const { t } = useTranslations();

  return (
    <section
      aria-labelledby="settings-section-thresholds-title"
      className="space-y-6"
    >
      <header className="space-y-1">
        <h1
          id="settings-section-thresholds-title"
          className="text-2xl font-semibold tracking-tight"
        >
          {t("settings.sections.thresholds.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.thresholds.description")}
        </p>
      </header>

      <ThresholdsSection id="thresholds" />
    </section>
  );
}
