"use client";

/**
 * `<ChannelsSection>` — Settings → Kanäle (notification delivery channels).
 *
 * v1.18.1 (D4) — split out of the Integrations sub-tabs into its own left-side
 * entry. A channel (Telegram / ntfy / Web Push / Webhook / Email) is a
 * delivery provider — the same family as a connected device — and now reads as
 * a first-class settings home rather than a tab hidden behind Integrationen.
 *
 * The content is the existing `<NotificationChannelsPanel>`. v1.18.6 (W9) —
 * the visible heading + subtitle now come from the shared
 * `<SettingsSectionFrame>` in the route; this wrapper is the panel only.
 */

import { NotificationChannelsPanel } from "@/components/settings/integrations/notification-channels-panel";

export function ChannelsSection() {
  return <NotificationChannelsPanel />;
}
