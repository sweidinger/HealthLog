"use client";

/**
 * `<ChannelsSection>` — Settings → Kanäle (notification delivery channels).
 *
 * v1.18.1 (D4) — split out of the Integrations sub-tabs into its own left-side
 * entry. A channel (Telegram / ntfy / Web Push / Webhook / Email) is a
 * delivery provider — the same family as a connected device — and now reads as
 * a first-class settings home rather than a tab hidden behind Integrationen.
 *
 * The content is the existing `<NotificationChannelsPanel>`; this wrapper only
 * owns the section frame (sr-only heading scaffold matching every other
 * settings section).
 */

import { NotificationChannelsPanel } from "@/components/settings/integrations/notification-channels-panel";
import { useTranslations } from "@/lib/i18n/context";

export function ChannelsSection() {
  const { t } = useTranslations();

  return (
    <section
      aria-labelledby="settings-section-channels-title"
      className="space-y-6"
    >
      {/* v1.18.1 (D0) — section blurb dropped for consistent top alignment. */}
      <header>
        <h1 id="settings-section-channels-title" className="sr-only">
          {t("settings.sections.channels.title")}
        </h1>
      </header>

      <NotificationChannelsPanel />
    </section>
  );
}
