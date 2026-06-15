"use client";

import Link from "next/link";
import {
  Bell,
  ChevronRight,
  HeartPulse,
  MessageCircle,
  Package,
  Pill,
  Smile,
  Stethoscope,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.17.1 — the one "Reminders & Notifications" home.
 *
 * Before this section, "what gets reminded and when" was scattered across
 * three unrelated homes: medication reminders lived per-medication on the med
 * cards, mood + low-stock + coach-nudge lived inside the Notifications channel
 * screen, and the new Vorsorge (preventive-care) reminders had their own
 * page. There was no single place that answered "was erinnert mich woran,
 * wann, und worüber".
 *
 * This hub is the single front door. It draws a clean line between two
 * genuinely different concepts (so the maintainer rule "never split the same
 * concept across a page" still holds):
 *
 *   - CHANNELS — the *how/where* a reminder is delivered (APNs / Telegram /
 *     ntfy / Web Push / Webhook / Email). These keep living on the
 *     Notifications channel screen; this hub links to them.
 *   - CATEGORIES — the *what/when*: medication, mood, Vorsorge, low-stock
 *     runway, and the proactive Coach nudge. Each keeps its own canonical
 *     editor and deep link; the hub just gathers them so the concept reads
 *     as one place.
 *
 * Consolidation by linking — every existing editor stays intact and
 * deep-linkable; nothing here is a rewrite.
 */
interface ReminderLink {
  href: string;
  icon: LucideIcon;
  titleKey: string;
  descriptionKey: string;
  /** External-to-settings link (opens a feature page, not a settings tab). */
  testId: string;
}

const CHANNEL_LINKS: ReadonlyArray<ReminderLink> = [
  {
    href: "/settings/notifications",
    icon: Bell,
    titleKey: "settings.sections.reminders.channels.title",
    descriptionKey: "settings.sections.reminders.channels.description",
    testId: "reminders-link-channels",
  },
];

const CATEGORY_LINKS: ReadonlyArray<ReminderLink> = [
  {
    href: "/medications",
    icon: Pill,
    titleKey: "settings.sections.reminders.medication.title",
    descriptionKey: "settings.sections.reminders.medication.description",
    testId: "reminders-link-medication",
  },
  {
    href: "/vorsorge",
    icon: Stethoscope,
    titleKey: "settings.sections.reminders.vorsorge.title",
    descriptionKey: "settings.sections.reminders.vorsorge.description",
    testId: "reminders-link-vorsorge",
  },
  {
    href: "/settings/notifications#mood-reminder",
    icon: Smile,
    titleKey: "settings.sections.reminders.mood.title",
    descriptionKey: "settings.sections.reminders.mood.description",
    testId: "reminders-link-mood",
  },
  {
    href: "/settings/notifications#low-stock",
    icon: Package,
    titleKey: "settings.sections.reminders.lowStock.title",
    descriptionKey: "settings.sections.reminders.lowStock.description",
    testId: "reminders-link-low-stock",
  },
  {
    href: "/settings/notifications#coach-nudge",
    icon: MessageCircle,
    titleKey: "settings.sections.reminders.coach.title",
    descriptionKey: "settings.sections.reminders.coach.description",
    testId: "reminders-link-coach",
  },
];

function ReminderLinkCard({ link }: { link: ReminderLink }) {
  const { t } = useTranslations();
  const Icon = link.icon;
  return (
    <li>
      <Link
        href={link.href}
        data-testid={link.testId}
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
}

export function RemindersSection() {
  const { t } = useTranslations();

  return (
    <section
      aria-labelledby="settings-section-reminders-title"
      className="space-y-6"
    >
      <header className="space-y-1">
        <h1 id="settings-section-reminders-title" className="sr-only">
          {t("settings.sections.reminders.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.reminders.description")}
        </p>
      </header>

      {/* CATEGORIES — the what/when. */}
      <div className="space-y-3">
        <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium tracking-wide uppercase">
          <HeartPulse className="h-3.5 w-3.5" aria-hidden="true" />
          {t("settings.sections.reminders.categoriesGroup")}
        </div>
        <ul className="space-y-3">
          {CATEGORY_LINKS.map((link) => (
            <ReminderLinkCard key={link.href} link={link} />
          ))}
        </ul>
      </div>

      {/* CHANNELS — the how/where. */}
      <div className="space-y-3">
        <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium tracking-wide uppercase">
          <Bell className="h-3.5 w-3.5" aria-hidden="true" />
          {t("settings.sections.reminders.channelsGroup")}
        </div>
        <ul className="space-y-3">
          {CHANNEL_LINKS.map((link) => (
            <ReminderLinkCard key={link.href} link={link} />
          ))}
        </ul>
      </div>
    </section>
  );
}
