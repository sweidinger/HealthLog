"use client";

import Link from "next/link";
import {
  ChevronRight,
  LayoutDashboard,
  Pill,
  Smile,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.17.1 (F-2) — the one "Layout & Personalization" home.
 *
 * Before this section, "how my app is laid out" was scattered across four
 * unrelated settings sections — Dashboard, Insights, Medications, Mood —
 * with no shared framing, so the same concept (arrange / reorder / show-
 * hide) read as four disconnected places. This section is the single
 * front door: it presents the four personalization surfaces as one
 * consistent set of cards and links to each editor, which all keep their
 * own routes and mutation flows intact. One concept, one home.
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
  {
    href: "/settings/medications",
    icon: Pill,
    titleKey: "settings.sections.layout.medications.title",
    descriptionKey: "settings.sections.layout.medications.description",
  },
  {
    href: "/settings/mood",
    icon: Smile,
    titleKey: "settings.sections.layout.mood.title",
    descriptionKey: "settings.sections.layout.mood.description",
  },
];

export function LayoutSection() {
  const { t } = useTranslations();

  return (
    <section
      aria-labelledby="settings-section-layout-title"
      className="space-y-6"
    >
      <header className="space-y-1">
        <h1 id="settings-section-layout-title" className="sr-only">
          {t("settings.sections.layout.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.layout.description")}
        </p>
      </header>

      <ul className="space-y-3">
        {LAYOUT_LINKS.map((link) => {
          const Icon = link.icon;
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                className={cn(
                  "bg-card border-border hover:bg-accent/40 group flex items-center gap-4 rounded-xl border p-4 transition-colors sm:p-5",
                )}
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
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
