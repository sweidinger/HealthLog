"use client";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { AdminShell } from "@/components/admin/admin-shell";
import { SystemStatusSummary } from "@/components/admin/system-status-summary";
import { RecentAuditPreview } from "@/components/admin/recent-audit-preview";
import { useAdminSettings } from "@/components/admin/_shared";

/**
 * `/admin` — overview landing page. v1.4.15 (phase A2) replaces the
 * previous status-card grid + section quick-jump menu with two
 * at-a-glance panes: a compact system snapshot and the 10 most recent
 * audit entries. The section navigation is already exposed in the
 * shell sidebar (and in the global app sidebar after Phase 4b), so the
 * old grid duplicated existing nav. See `.planning/phase-A2-report.md`.
 */
export default function AdminOverviewPage() {
  const { user } = useAuth();
  const { t } = useTranslations();
  // Surface admin-settings fetch failures once at the top of the page.
  // Many sub-sections share `useAdminSettings()` and render defaults
  // silently on error — the banner makes the failure visible so the
  // admin knows the toggles below aren't reflecting real state.
  const { isError: settingsError } = useAdminSettings();

  if (!user || user.role !== "ADMIN") return null;

  return (
    <AdminShell>
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-bold tracking-tight">
            {t("admin.title")}
          </h1>
          <p className="text-muted-foreground text-sm">{t("admin.subtitle")}</p>
        </header>

        {settingsError && (
          <div
            role="alert"
            className="text-destructive bg-destructive/10 border-destructive/30 rounded-md border px-3 py-2 text-sm"
          >
            {t("admin.adminSettingsLoadError")}
          </div>
        )}

        {/* Welcome card — greeting with admin context indicator. */}
        <section
          aria-labelledby="admin-overview-welcome-heading"
          className="bg-card border-border rounded-xl border p-6"
        >
          <h2
            id="admin-overview-welcome-heading"
            className="text-lg font-semibold"
          >
            {t("admin.overview.welcomeTitle", { name: user.username })}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            {t("admin.overview.welcomeSubtitle")}
          </p>
        </section>

        <SystemStatusSummary />

        <RecentAuditPreview />
      </div>
    </AdminShell>
  );
}
