"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { AdminShell, ADMIN_SECTIONS } from "@/components/admin/admin-shell";
import { StatusCardGrid } from "@/components/admin/status-card-grid";
import { useAdminSettings } from "@/components/admin/_shared";

/**
 * `/admin` — overview landing page. The long monolithic admin scroll has
 * moved to per-section dynamic routes under `/admin/[section]`; this page
 * is now the system-wide status grid plus a quick-jump menu of the
 * available sub-sections.
 *
 * Bundle-size note: by extracting each section into its own route, the
 * overview no longer ships the umami / glitchtip / feedback /
 * users / etc. component trees. See `.planning/phase-4b-report.md`.
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
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {t("admin.title")}
          </h1>
          <p className="text-muted-foreground text-sm">{t("admin.subtitle")}</p>
        </div>

        {settingsError && (
          <div
            role="alert"
            className="text-destructive bg-destructive/10 border-destructive/30 rounded-md border px-3 py-2 text-sm"
          >
            {t("admin.adminSettingsLoadError")}
          </div>
        )}

        <StatusCardGrid />

        {/* v1.5 phase-5: wrap the quick-jump list in a labelled <nav> so
            screen-reader landmark navigation can distinguish it from the
            sidebar nav (which already has its own aria-label). */}
        <nav aria-labelledby="admin-overview-sections-heading">
          <h2
            id="admin-overview-sections-heading"
            className="text-muted-foreground mb-3 text-sm font-semibold tracking-wider uppercase"
          >
            {t("admin.shell.sectionsNav")}
          </h2>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {ADMIN_SECTIONS.map((section) => {
              const Icon = section.icon;
              return (
                <li key={section.slug}>
                  <Link
                    href={`/admin/${section.slug}`}
                    className="bg-card border-border hover:bg-accent flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm font-medium transition-colors"
                  >
                    <span className="flex items-center gap-2">
                      <Icon
                        className="text-muted-foreground h-4 w-4"
                        aria-hidden="true"
                      />
                      {t(section.titleKey)}
                    </span>
                    <ArrowRight
                      className="text-muted-foreground h-4 w-4"
                      aria-hidden="true"
                    />
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </AdminShell>
  );
}
