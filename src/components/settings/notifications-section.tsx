"use client";

import Link from "next/link";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { CoachNudgeCard } from "@/components/settings/coach-nudge-card";
import { LowStockCard } from "@/components/settings/low-stock-card";
import { MoodReminderCard } from "@/components/settings/mood-reminder-card";
import { VorsorgeSection } from "@/components/measurement-reminders/vorsorge-section";

/**
 * `<NotificationsSection>` — Settings → Notifications ("Benachrichtigungen").
 *
 * v1.18.0 (S4) — the single module-gated home for reminder TYPES. Earlier the
 * settings carried two near-identical entries: this Notifications screen and a
 * separate "Erinnerungen" hub that only deep-linked into the canonical editors
 * ("doppelt gemoppelt"). The hub is gone (its route 301-redirects here); the
 * reminder TYPES now live centrally on this one screen.
 *
 * Each reminder-type card is shown ONLY when its module is enabled, read from
 * the resolved `useAuth().user.modules` map (the same `/auth/me` map nav and
 * Insights pills gate off). Mood → `mood`, Coach nudge → `coach`. Low-stock
 * runway maps to the medications CORE domain, so it is always shown. Vorsorge
 * (preventive-care) reminders are not a toggleable module, so they are always
 * shown. The gate fails OPEN: a missing key reads as enabled, so a stale
 * `/me` payload never blanks a card.
 *
 * Delivery CHANNELS (Telegram / ntfy / Web Push / Webhook / Email) are a
 * different concept — a channel is a delivery provider, the same family as a
 * connected device — and live under Settings → Integrations → Channels (moved
 * there in S3). A single concise pointer below the heading links to them.
 */
export function NotificationsSection() {
  const { t } = useTranslations();
  const { isAuthenticated, user } = useAuth();

  // v1.18.0 (S4) — module-gated per-type visibility. Fail OPEN (`!== false`)
  // so a stale `/me` payload without the module map keeps every card visible.
  const moodEnabled = user?.modules?.mood !== false;
  const coachEnabled = user?.modules?.coach !== false;

  return (
    <section
      aria-labelledby="settings-section-notifications-title"
      className="space-y-6"
    >
      <header className="space-y-1">
        {/* sr-only h1 — the visible section title is painted by the settings
            shell nav; the in-page heading mirrors every other settings
            section's scaffold so the screen reads as one of the family. */}
        <h1 id="settings-section-notifications-title" className="sr-only">
          {t("settings.sections.notifications.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.notifications.description")}
        </p>
        {/* One concise pointer to the delivery channels (now under
            Integrations) and one to the notification inbox — not a duplicated
            section, just where-to-go links. */}
        <p className="text-muted-foreground text-xs">
          {t("settings.sections.notifications.channelsHint")}{" "}
          <Link
            href="/settings/integrations"
            className="text-primary underline underline-offset-2"
            data-slot="notifications-channels-cross-link"
          >
            {t("settings.sections.notifications.channelsHintLink")}
          </Link>
          {" · "}
          <Link
            href="/notifications"
            className="text-primary underline underline-offset-2"
            data-slot="notifications-inbox-cross-link"
          >
            {t("settings.sections.notifications.inboxLink")}
          </Link>
        </p>
      </header>

      {/* Vorsorge (preventive-care) reminders — always shown; not a
          toggleable module. The canonical in-place editor, embedded here so
          "what gets reminded and when" reads as one screen. */}
      <VorsorgeSection enabled={isAuthenticated} />

      {/* Mood check-in reminder — only when the mood module is enabled. */}
      {moodEnabled ? (
        <div id="mood-reminder" className="scroll-mt-28">
          <MoodReminderCard isAuthenticated={isAuthenticated} />
        </div>
      ) : null}

      {/* Medication low-stock runway — medications is a CORE domain, so this
          is always shown. */}
      <div id="low-stock" className="scroll-mt-28">
        <LowStockCard isAuthenticated={isAuthenticated} />
      </div>

      {/* Proactive Coach nudge — only when the coach module is enabled. */}
      {coachEnabled ? (
        <div id="coach-nudge" className="scroll-mt-28">
          <CoachNudgeCard isAuthenticated={isAuthenticated} />
        </div>
      ) : null}
    </section>
  );
}
