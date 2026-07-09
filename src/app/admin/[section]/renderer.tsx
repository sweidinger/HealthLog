"use client";

/**
 * Client-only renderer that picks the right admin section component for
 * a given slug. Lives next to the route page so the shell can stay a
 * server component while the auth-gated body remains a client component.
 *
 * This is the equivalent of `SECTION_COMPONENTS` in
 * `src/app/settings/[section]/page.tsx`, lifted to a separate file so
 * the route page can be a server component (Settings can keep
 * `"use client"`-leaning components in its page because none of them
 * read `useAuth()` to gate rendering).
 */

import type { JSX } from "react";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { AboutSection } from "@/components/settings/about-section";
import { AiQualitySection } from "@/components/admin/ai-quality-section";
import { AiServerKeySection } from "@/components/admin/ai-server-key-section";
import { CentralCodexSection } from "@/components/admin/central-codex-section";
import { AssistantSection } from "@/components/admin/assistant-section";
import { CoachFeedbackSection } from "@/components/admin/coach-feedback-section";
import { ApiTokenOverviewSection } from "@/components/admin/api-token-overview-section";
import { AppLogPreviewSection } from "@/components/admin/app-log-preview-section";
import { BackupsSection } from "@/components/admin/backups-section";
import { DangerZoneSection } from "@/components/admin/danger-zone-section";
import { EncryptionSection } from "@/components/admin/encryption-section";
import { GeneralSettingsSection } from "@/components/admin/general-settings-section";
import { IntegrationsGroupSection } from "@/components/admin/integrations-group-section";
import { LoginOverviewSection } from "@/components/admin/login-overview-section";
import { ModuleAvailabilitySection } from "@/components/admin/module-availability-section";
import { RemindersSection } from "@/components/admin/reminders-section";
import { ServicesSection } from "@/components/admin/services-section";
import { SystemStatusSection } from "@/components/admin/system-status-section";
import { InviteTokensSection } from "@/components/admin/invite-tokens-section";
import { UserManagementSection } from "@/components/admin/user-management-section";
import type { AdminSectionSlug } from "@/components/admin/section-slugs";

interface RendererProps {
  slug: AdminSectionSlug;
}

export function AdminSectionRenderer({
  slug,
}: RendererProps): JSX.Element | null {
  const { user } = useAuth();
  const { t } = useTranslations();

  // The admin shell layout already gates non-admins via `<AuthShell>`,
  // but the auth hook is async — return nothing on the first render so
  // we don't flash sub-section UI to a non-admin who's about to get
  // redirected to `/`.
  if (!user || user.role !== "ADMIN") return null;

  switch (slug) {
    case "system-status":
      return (
        <SectionFrame
          title={t("admin.section.system-status.title")}
          subtitle={t("admin.section.system-status.subtitle")}
        >
          <SystemStatusSection />
        </SectionFrame>
      );
    case "general":
      return (
        <SectionFrame
          title={t("admin.section.general.title")}
          subtitle={t("admin.section.general.subtitle")}
        >
          <GeneralSettingsSection />
        </SectionFrame>
      );
    case "services":
      return (
        <SectionFrame
          title={t("admin.section.services.title")}
          subtitle={t("admin.section.services.subtitle")}
        >
          <ServicesSection />
        </SectionFrame>
      );
    case "integrations":
      return (
        <SectionFrame
          title={t("admin.section.integrations.title")}
          subtitle={t("admin.section.integrations.subtitle")}
        >
          <IntegrationsGroupSection />
        </SectionFrame>
      );
    case "coach":
      // v1.18.1 — the former ai-quality, assistant, and coach-feedback
      // sections fold into one Coach area: surface toggles + operator
      // config first, then the two feedback-quality tables.
      // v1.18.6 (W9) — server-wide module availability moved out to its own
      // `module-availability` section: it gates EVERY module, not just the
      // coach, so it no longer belongs stacked under Coach.
      return (
        <SectionFrame
          title={t("admin.section.coach.title")}
          subtitle={t("admin.section.coach.subtitle")}
        >
          <AssistantSection />
          <AiServerKeySection />
          <CentralCodexSection />
          <CoachFeedbackSection />
          <AiQualitySection />
        </SectionFrame>
      );
    case "module-availability":
      // v1.18.6 (W9) — operator-side server-wide module on/off, its own
      // admin section (was stacked under Coach). Reconciled name: the
      // user-facing "Module" settings pick from what is available here.
      return (
        <SectionFrame
          title={t("admin.section.module-availability.title")}
          subtitle={t("admin.section.module-availability.subtitle")}
        >
          <ModuleAvailabilitySection />
        </SectionFrame>
      );
    case "reminders":
      return (
        <SectionFrame
          title={t("admin.section.reminders.title")}
          subtitle={t("admin.section.reminders.subtitle")}
        >
          <RemindersSection />
        </SectionFrame>
      );
    case "users":
      return (
        <SectionFrame
          title={t("admin.section.users.title")}
          subtitle={t("admin.section.users.subtitle")}
        >
          <UserManagementSection />
        </SectionFrame>
      );
    case "invites":
      // v1.16.0 — invites moved out of Users into their own section:
      // the full table (status, redemptions, revocation) is a workflow
      // of its own and was drowning under the account list.
      return (
        <SectionFrame
          title={t("admin.section.invites.title")}
          subtitle={t("admin.section.invites.subtitle")}
        >
          <InviteTokensSection />
        </SectionFrame>
      );
    case "api-tokens":
      return (
        <SectionFrame
          title={t("admin.section.api-tokens.title")}
          subtitle={t("admin.section.api-tokens.subtitle")}
        >
          <ApiTokenOverviewSection />
        </SectionFrame>
      );
    case "login-overview":
      return (
        <SectionFrame
          title={t("admin.section.login-overview.title")}
          subtitle={t("admin.section.login-overview.subtitle")}
        >
          <LoginOverviewSection />
        </SectionFrame>
      );
    case "app-logs":
      return (
        <SectionFrame
          title={t("admin.section.app-logs.title")}
          subtitle={t("admin.section.app-logs.subtitle")}
        >
          <AppLogPreviewSection />
        </SectionFrame>
      );
    case "backups":
      return (
        <SectionFrame
          title={t("admin.section.backups.title")}
          subtitle={t("admin.section.backups.subtitle")}
        >
          <BackupsSection />
        </SectionFrame>
      );
    case "encryption":
      return (
        <SectionFrame
          title={t("admin.section.encryption.title")}
          subtitle={t("admin.section.encryption.subtitle")}
        >
          <EncryptionSection />
        </SectionFrame>
      );
    case "danger-zone":
      return (
        <SectionFrame
          title={t("admin.section.danger-zone.title")}
          subtitle={t("admin.section.danger-zone.subtitle")}
        >
          <DangerZoneSection />
        </SectionFrame>
      );
    case "about":
      // v1.4.36 W4e — About section reused as-is from the settings surface.
      // v1.18.6 (W9) — route it through `SectionFrame` like every other admin
      // section so it gets the same visible heading + subtitle (the one admin
      // page that was bypassing the frame and showing no heading).
      return (
        <SectionFrame
          title={t("admin.section.about.title")}
          subtitle={t("admin.section.about.subtitle")}
        >
          <AboutSection />
        </SectionFrame>
      );
    default:
      slug satisfies never;
      return null;
  }
}

interface SectionFrameProps {
  // v1.18.6.1 — the visible heading + subtitle moved to `<AdminShell>`, which
  // places them in their own grid row so the left nav lines up with the first
  // card. `title` / `subtitle` are still passed by every call site (and remain
  // the i18n source of truth the shell reads), but the frame no longer paints
  // them — it is now just the `space-y-6` card-stack wrapper.
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
}

function SectionFrame({ children }: SectionFrameProps) {
  return <div className="space-y-6">{children}</div>;
}
