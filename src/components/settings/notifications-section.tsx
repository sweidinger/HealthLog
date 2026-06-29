"use client";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { LowStockCard } from "@/components/settings/low-stock-card";
import { MoodReminderCard } from "@/components/settings/mood-reminder-card";
import { NotificationChannelsPanel } from "@/components/settings/integrations/notification-channels-panel";

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
 * v1.25.3 — the standalone "Channels" entry folds back in here. The page is
 * now one Notifications surface with two sequential, labelled groups, ordered
 * the way a user reasons about it: **Reminders** ("what you receive") first,
 * then **Delivery channels** ("where it's delivered") = the existing
 * `<NotificationChannelsPanel>`. This is two distinct-but-related concepts
 * sequenced under one roof, not one concept split top/bottom — the
 * channels group carries `id="channels"` so `/settings/channels` can
 * 301-redirect to `/settings/notifications#channels`, and the per-channel
 * anchors (`#telegram`, `#ntfy`, …) inside the panel keep working.
 *
 * v1.18.6 (W9) — the page heading + subtitle come from the shared
 * `<SettingsSectionFrame>`. The proactive-Coach nudge card lives under
 * Settings → Coach (it is a Coach setting, not a generic notification).
 */
export function NotificationsSection() {
  const { isAuthenticated, user } = useAuth();
  const { t } = useTranslations();

  // v1.18.0 (S4) — module-gated per-type visibility. Fail OPEN (`!== false`)
  // so a stale `/me` payload without the module map keeps every card visible.
  const moodEnabled = user?.modules?.mood !== false;
  const medsEnabled = user?.modules?.medications !== false;
  const anyReminder = moodEnabled || medsEnabled;

  return (
    <div className="space-y-10">
      {/* Group 1 — Reminders ("what you receive"). Rendered only when at
          least one reminder-type card is visible, so a fully-disabled
          account never shows an empty heading. */}
      {anyReminder ? (
        <section className="space-y-4">
          <div className="space-y-0.5">
            <h2 className="text-foreground text-lg font-semibold">
              {t("settings.sections.notifications.remindersHeading")}
            </h2>
            <p className="text-muted-foreground text-sm">
              {t("settings.sections.notifications.remindersDescription")}
            </p>
          </div>

          {/* Mood check-in reminder — only when the mood module is enabled. */}
          {moodEnabled ? (
            <div id="mood-reminder" className="scroll-mt-28">
              <MoodReminderCard isAuthenticated={isAuthenticated} />
            </div>
          ) : null}

          {/* Medication low-stock runway — only when the medications module
              is enabled (toggleable, fail-open, since D3). */}
          {medsEnabled ? (
            <div id="low-stock" className="scroll-mt-28">
              <LowStockCard isAuthenticated={isAuthenticated} />
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Group 2 — Delivery channels ("where it's delivered"). The existing
          channels panel, unchanged. `id="channels"` anchors the group for the
          `/settings/channels` redirect. */}
      <section id="channels" className="scroll-mt-28 space-y-4">
        <div className="space-y-0.5">
          <h2 className="text-foreground text-lg font-semibold">
            {t("settings.sections.notifications.channelsHeading")}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t("settings.sections.notifications.channelsDescription")}
          </p>
        </div>
        <NotificationChannelsPanel />
      </section>
    </div>
  );
}
