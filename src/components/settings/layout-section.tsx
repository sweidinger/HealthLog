"use client";

import Link from "next/link";
import {
  CalendarCheck,
  ChevronRight,
  FlaskConical,
  LayoutDashboard,
  Pill,
  Thermometer,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { SettingsCard } from "./settings-card";

/**
 * v1.17.1 (F-2) — the "Appearance" home (slug stays `layout`).
 *
 * "How my app looks and is arranged" was scattered across several unrelated
 * settings sections with no shared framing. This section is the single front
 * door: it presents the view/arrangement surfaces as one consistent set of
 * cards and links to each editor, which keep their own routes, their own
 * cards, and their mutation flows intact — the hub indexes them, it does not
 * own them.
 *
 * v1.25.3 — the hub widens from the dashboard + insights arrangement editors
 * to the full set of view surfaces: it now also deep-links to the view/sort/
 * order cards of medications, labs, the illness journal, and checkups. Each
 * of those modules keeps its view cards on its own settings page; the links
 * land on the existing card anchors (`#medications-view`, `#labs-view`,
 * `#illness-view`, `#vorsorge-view`). Data/behaviour settings (biomarker
 * catalog, local OCR, injection-site exclusions, per-reminder toggles, the
 * mood tag/group catalog) stay on their module pages and are NOT indexed here.
 */
interface LayoutLink {
  href: string;
  icon: LucideIcon;
  titleKey: string;
  descriptionKey: string;
}

const LAYOUT_LINKS: ReadonlyArray<LayoutLink> = [
  {
    href: "/settings/dashboard",
    icon: LayoutDashboard,
    titleKey: "settings.sections.layout.dashboard.title",
    descriptionKey: "settings.sections.layout.dashboard.description",
  },
  {
    href: "/settings/insights",
    icon: TrendingUp,
    titleKey: "settings.sections.layout.insights.title",
    descriptionKey: "settings.sections.layout.insights.description",
  },
  // v1.25.3 — view/sort/order surfaces of the tracking modules. Each link
  // deep-links to the module's existing view card anchor; the cards stay on
  // their own settings page. The module routes resolve regardless of the
  // module's enabled state, so the link never dead-ends.
  {
    href: "/settings/medications#medications-view",
    icon: Pill,
    titleKey: "settings.sections.layout.medications.title",
    descriptionKey: "settings.sections.layout.medications.description",
  },
  {
    href: "/settings/labs#labs-view",
    icon: FlaskConical,
    titleKey: "settings.sections.layout.labs.title",
    descriptionKey: "settings.sections.layout.labs.description",
  },
  {
    href: "/settings/illness#illness-view",
    icon: Thermometer,
    titleKey: "settings.sections.layout.illness.title",
    descriptionKey: "settings.sections.layout.illness.description",
  },
  {
    href: "/settings/vorsorge#vorsorge-view",
    icon: CalendarCheck,
    titleKey: "settings.sections.layout.vorsorge.title",
    descriptionKey: "settings.sections.layout.vorsorge.description",
  },
];

export function LayoutSection() {
  const { t } = useTranslations();

  // The visible heading + subtitle are painted by `SettingsShell` from the
  // section slug; this body is the hub link list.
  return (
    <ul className="space-y-3">
      {LAYOUT_LINKS.map((link) => {
        const Icon = link.icon;
        return (
          <li key={link.href}>
            <SettingsCard
              as={Link}
              href={link.href}
              className="hover:bg-accent/40 group flex items-center gap-4 transition-colors"
            >
              <Icon
                className="text-muted-foreground h-5 w-5 shrink-0"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-sm font-semibold">{t(link.titleKey)}</p>
                <p className="text-muted-foreground text-xs">
                  {t(link.descriptionKey)}
                </p>
              </div>
              <ChevronRight
                className="text-muted-foreground/60 group-hover:text-foreground h-4 w-4 shrink-0 transition-colors"
                aria-hidden="true"
              />
            </SettingsCard>
          </li>
        );
      })}
    </ul>
  );
}
