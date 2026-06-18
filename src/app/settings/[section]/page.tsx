import { notFound } from "next/navigation";
import type { JSX, ReactNode } from "react";

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
import { SettingsSectionFrame } from "@/components/settings/settings-section-frame";
import { SettingsHubBackLink } from "@/components/settings/settings-hub-back-link";
import { ModuleTourTrigger } from "@/components/onboarding/module-tour-trigger";

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

// v1.18.6 (W9) — the two Layout-hub child editors render a "← back to hub"
// link above their heading. The shared `<SettingsSectionFrame>` exposes a
// `topSlot` for exactly this; the link lives here so the section bodies stay
// pure card content.
const HUB_CHILD_SLUGS: ReadonlySet<SettingsSectionSlug> = new Set([
  "dashboard",
  "insights",
]);

/** Optional content rendered above the canonical heading, per slug. */
function frameTopSlot(slug: SettingsSectionSlug): ReactNode {
  if (HUB_CHILD_SLUGS.has(slug)) {
    return (
      <SettingsHubBackLink
        href="/settings/layout"
        labelKey="settings.sections.layout.backToHub"
      />
    );
  }
  return undefined;
}

/** Optional inline content rendered at the top-right of the heading row. */
function frameHeadingAccessory(slug: SettingsSectionSlug): ReactNode {
  // v1.18.6 (W9) — the module guided-tour re-entry triggers used to live in
  // a `justify-end` header inside the section body; they move to the frame's
  // heading row so the heading itself is the spotlight anchor.
  if (slug === "gesundheitsakte") {
    return (
      <span data-tour-id="export-hero">
        <ModuleTourTrigger stopId="export" />
      </span>
    );
  }
  if (slug === "integrations") {
    return (
      <span data-tour-id="integrations-hero">
        <ModuleTourTrigger stopId="integrations" />
      </span>
    );
  }
  return undefined;
}

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
  // v1.18.6 (W9) — every section now renders inside the shared
  // `<SettingsSectionFrame>`, which emits the one visible heading + subtitle
  // each page must show (the section bodies no longer carry their own).
  const body = SectionComponent ? (
    <SettingsSectionFrame
      slug={section}
      topSlot={frameTopSlot(section)}
      headingAccessory={frameHeadingAccessory(section)}
    >
      <SectionComponent />
    </SettingsSectionFrame>
  ) : (
    <SectionPlaceholder slug={section} />
  );

  return <SettingsShell active={section}>{body}</SettingsShell>;
}
