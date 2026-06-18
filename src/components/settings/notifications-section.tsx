"use client";

import { useAuth } from "@/hooks/use-auth";
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
 * Insights pills gate off). Mood → `mood`, low-stock runway → `medications`
 * (a toggleable fail-open module since D3, so a missing key reads as enabled
 * and a stale `/me` payload never blanks a card).
 *
 * v1.18.1 (D5) — the page is intentionally lean: the section blurb, the
 * channels / inbox cross-links, and the embedded Vorsorge (preventive-care)
 * editor were all removed. Vorsorge has its own `/vorsorge` page, so embedding
 * it here was a duplicate. Delivery CHANNELS (Telegram / ntfy / Web Push /
 * Webhook / Email) live under Settings → Integrations → Channels.
 *
 * v1.18.6 (W9) — the visible heading + subtitle now come from the shared
 * `<SettingsSectionFrame>`. The proactive-Coach nudge card moved to Settings →
 * Coach (it is a Coach setting, not a generic notification), so this screen
 * carries the mood + low-stock reminder cards only.
 */
export function NotificationsSection() {
  const { isAuthenticated, user } = useAuth();

  // v1.18.0 (S4) — module-gated per-type visibility. Fail OPEN (`!== false`)
  // so a stale `/me` payload without the module map keeps every card visible.
  const moodEnabled = user?.modules?.mood !== false;
  const medsEnabled = user?.modules?.medications !== false;

  return (
    <div className="space-y-6">
      {/* Mood check-in reminder — only when the mood module is enabled. */}
      {moodEnabled ? (
        <div id="mood-reminder" className="scroll-mt-28">
          <MoodReminderCard isAuthenticated={isAuthenticated} />
        </div>
      ) : null}

      {/* Medication low-stock runway — only when the medications module is
          enabled (toggleable, fail-open, since D3). */}
      {medsEnabled ? (
        <div id="low-stock" className="scroll-mt-28">
          <LowStockCard isAuthenticated={isAuthenticated} />
        </div>
      ) : null}
    </div>
  );
}
