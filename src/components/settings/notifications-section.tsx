"use client";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { CoachNudgeCard } from "@/components/settings/coach-nudge-card";
import { LowStockCard } from "@/components/settings/low-stock-card";
import { MoodReminderCard } from "@/components/settings/mood-reminder-card";

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
 * runway maps to medications, which fails open (a missing key reads as
 * enabled) so a stale `/me` payload never blanks a card.
 *
 * v1.18.1 (D5) — the page is intentionally lean: the section blurb, the
 * channels / inbox cross-links, and the embedded Vorsorge (preventive-care)
 * editor were all removed. Vorsorge has its own `/vorsorge` page, so embedding
 * it here was a duplicate. Delivery CHANNELS (Telegram / ntfy / Web Push /
 * Webhook / Email) live under Settings → Integrations → Channels.
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
      {/* v1.18.1 (D0/D5) — the section blurb and the channels / inbox cross-
          links were dropped: the header now starts at the same height as every
          other section and the page carries only the reminder-type cards. */}
      <header>
        <h1 id="settings-section-notifications-title" className="sr-only">
          {t("settings.sections.notifications.title")}
        </h1>
      </header>

      {/* v1.18.1 (D5) — the Vorsorge (preventive-care) block was removed; it
          has its own /vorsorge page, so embedding the editor here was a
          duplicate. This screen keeps the three reminder-type cards below. */}

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
