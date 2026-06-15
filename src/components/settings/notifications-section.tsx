"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { CoachNudgeCard } from "@/components/settings/coach-nudge-card";
import { LowStockCard } from "@/components/settings/low-stock-card";
import { MoodReminderCard } from "@/components/settings/mood-reminder-card";

/**
 * `<NotificationsSection>` — Settings → Notifications.
 *
 * v1.18.0 (S3) — the delivery CHANNELS (Telegram / ntfy / Web Push / Webhook /
 * Email + the live per-channel status surface) moved to Settings →
 * Integrations → Channels: a channel is a delivery provider, the same family as
 * a connected device, not a notification preference. What stays here is the
 * reminder-TYPE content (which events fire): mood reminder, medication
 * low-stock runway, proactive Coach nudge. S4 will consolidate these onto the
 * Reminders hub.
 */
export function NotificationsSection() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();

  return (
    <section
      aria-labelledby="settings-section-notifications-title"
      className="space-y-6"
    >
      {/* v1.4.33 IW7 — disambiguate this settings screen from the inbox at
          `/notifications`. The crumb spells out where the user is and offers a
          one-tap jump to the inbox. */}
      <nav
        aria-label={t("nav.breadcrumb")}
        className="text-muted-foreground text-xs"
      >
        <ol className="flex items-center gap-1">
          <li>{t("notifications.breadcrumbSettings")}</li>
          <li aria-hidden="true">
            <ChevronRight className="h-3 w-3" />
          </li>
          <li className="text-foreground font-medium">
            {t("notifications.breadcrumbChannels")}
          </li>
          <li aria-hidden="true">
            <ChevronRight className="h-3 w-3" />
          </li>
          <li>
            <Link
              href="/notifications"
              className="hover:text-foreground underline-offset-2 hover:underline"
            >
              {t("notifications.breadcrumbInbox")}
            </Link>
          </li>
        </ol>
      </nav>
      <header className="space-y-1">
        <h1 id="settings-section-notifications-title" className="sr-only">
          {t("settings.sections.notifications.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.notifications.description")}
        </p>
        {/* v1.18.0 (S3) — the delivery channels now live under Integrations.
            Cross-link so a user looking for "where do I connect Telegram"
            finds them in one tap. */}
        <p className="text-muted-foreground text-xs">
          {t("settings.sections.notifications.channelsHint")}{" "}
          <Link
            href="/settings/integrations"
            className="text-primary underline underline-offset-2"
            data-slot="notifications-channels-cross-link"
          >
            {t("settings.sections.notifications.channelsHintLink")}
          </Link>
        </p>
      </header>

      <div id="mood-reminder" className="scroll-mt-28">
        <MoodReminderCard isAuthenticated={isAuthenticated} />
      </div>
      {/* v1.16.11 — medication low-stock runway threshold. */}
      <div id="low-stock" className="scroll-mt-28">
        <LowStockCard isAuthenticated={isAuthenticated} />
      </div>
      {/* v1.15.20 — proactive Coach nudge opt-out. */}
      <div id="coach-nudge" className="scroll-mt-28">
        <CoachNudgeCard isAuthenticated={isAuthenticated} />
      </div>
    </section>
  );
}
