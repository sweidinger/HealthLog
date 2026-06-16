import { notFound } from "next/navigation";
import type { JSX } from "react";

import { AccountSection } from "@/components/settings/account-section";
import { AboutSection } from "@/components/settings/about-section";
import { AdvancedSection } from "@/components/settings/advanced-section";
import { AiSection } from "@/components/settings/ai-section";
import { ApiSection } from "@/components/settings/api-section";
import { CoachSection } from "@/components/settings/coach-section";
import { DashboardSection } from "@/components/settings/dashboard-section";
import { ExportSection } from "@/components/settings/export-section";
import { GesundheitsakteSection } from "@/components/settings/gesundheitsakte-section";
import { InsightsSection } from "@/components/settings/insights-section";
import { IntegrationsSection } from "@/components/settings/integrations-section";
import { LayoutSection } from "@/components/settings/layout-section";
import { MedicationsSection } from "@/components/settings/medications-section";
import { ModulesSection } from "@/components/settings/modules-section";
import { MoodSection } from "@/components/settings/mood-section";
import { NotificationsSection } from "@/components/settings/notifications-section";
import { SectionPlaceholder } from "@/components/settings/section-placeholder";
// v1.18.1 (D4) — `channels` and `sources` are standalone left-side entries
// again (split out of the Integrations sub-tabs).
import { ChannelsSection } from "@/components/settings/channels-section";
import { SourcesSection } from "@/components/settings/sources-section";
import { ThresholdsSection } from "@/components/settings/thresholds-section";
import {
  SETTINGS_SECTION_SLUGS,
  isSettingsSectionSlug,
  type SettingsSectionSlug,
} from "@/components/settings/section-slugs";
import { SettingsShell } from "@/components/settings/settings-shell";

/**
 * Dynamic settings section route. Each of the `SETTINGS_SECTION_SLUGS`
 * is pre-rendered at build via
 * `generateStaticParams()` so the URLs are
 * statically known to Next.js, while the `dynamicParams = false` flag below
 * tells the router to 404 (instead of attempting on-demand rendering) for any
 * slug not in the list — which is exactly what `notFound()` would do at
 * request time, just earlier and without rendering.
 */

export const dynamicParams = false;

export function generateStaticParams() {
  return SETTINGS_SECTION_SLUGS.map((section) => ({ section }));
}

const SECTION_COMPONENTS: Record<
  SettingsSectionSlug,
  () => JSX.Element | null
> = {
  account: AccountSection,
  modules: ModulesSection,
  about: AboutSection,
  ai: AiSection,
  coach: CoachSection,
  integrations: IntegrationsSection,
  channels: ChannelsSection,
  sources: SourcesSection,
  notifications: NotificationsSection,
  layout: LayoutSection,
  dashboard: DashboardSection,
  insights: InsightsSection,
  medications: MedicationsSection,
  mood: MoodSection,
  thresholds: ThresholdsSection,
  api: ApiSection,
  gesundheitsakte: GesundheitsakteSection,
  export: ExportSection,
  advanced: AdvancedSection,
};

interface PageProps {
  // Next.js 16 made route `params` an async Promise. We `await` it before use.
  params: Promise<{ section: string }>;
}

export default async function SettingsSectionPage({ params }: PageProps) {
  const { section } = await params;

  // Defence-in-depth — `dynamicParams = false` already 404s unknown slugs at
  // routing time, but we re-check here so a hand-rolled override of the route
  // config can never silently fall through to a typo'd slug.
  if (!isSettingsSectionSlug(section)) {
    notFound();
  }

  const SectionComponent = SECTION_COMPONENTS[section];
  // Defensive fallback: in theory unreachable since `isSettingsSectionSlug`
  // guards the slug, but a future slug added to `SETTINGS_SECTION_SLUGS`
  // without a wired component would otherwise crash silently — placeholder
  // surfaces the gap visually instead.
  const body = SectionComponent ? (
    <SectionComponent />
  ) : (
    <SectionPlaceholder slug={section} />
  );

  return <SettingsShell active={section}>{body}</SettingsShell>;
}
