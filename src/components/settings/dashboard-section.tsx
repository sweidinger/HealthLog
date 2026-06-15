"use client";

import { DashboardLayoutSection } from "@/components/settings/dashboard-layout-section";
import { SettingsHubBackLink } from "@/components/settings/settings-hub-back-link";
import { useTranslations } from "@/lib/i18n/context";

export function DashboardSection() {
  const { t } = useTranslations();

  return (
    <section
      aria-labelledby="settings-section-dashboard-title"
      className="space-y-6"
    >
      <header className="space-y-2">
        <SettingsHubBackLink
          href="/settings/layout"
          labelKey="settings.sections.layout.backToHub"
        />
        <h1 id="settings-section-dashboard-title" className="sr-only">
          {t("settings.sections.dashboard.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.dashboard.description")}
        </p>
      </header>

      <DashboardLayoutSection id="dashboard-layout" />
    </section>
  );
}
