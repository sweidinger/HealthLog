"use client";

import Link from "next/link";
import {
  ChevronRight,
  LayoutDashboard,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.17.1 (F-2) — the one "Layout & Personalization" home.
 *
 * Before this section, "how my app is laid out" was scattered across
 * several unrelated settings sections with no shared framing. This
 * section is the single front door for the arrangement editors: it
 * presents them as one consistent set of cards and links to each editor,
 * which keep their own routes and mutation flows intact.
 *
 * v1.18.0 (S5) — Medications (Medikamente) and Mood (Stimmung) graduated
 * to their own top-level nav entries, so the hub now hosts only the
 * dashboard + insights arrangement editors.
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
  // v1.18.0 (S5) — Medications (Medikamente) and Mood (Stimmung) graduated
  // to their own top-level nav entries, so they are no longer linked from
  // the Layout hub. Only the dashboard + insights arrangement editors
  // remain here.
];

export function LayoutSection() {
  const { t } = useTranslations();

  // v1.18.6 (W9) — the visible heading + subtitle now come from the shared
  // `<SettingsSectionFrame>` in the route; this body is the hub link list.
  return (
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
  );
}
