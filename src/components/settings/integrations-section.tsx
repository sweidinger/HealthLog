"use client";

/**
 * `<IntegrationsSection>` — Settings → Integrationen.
 *
 * v1.18.1 (D4) — the Connections content IS the Integrationen page: clicking
 * Integrationen shows the OAuth + device data sources (Withings / WHOOP /
 * Fitbit / Polar / Oura / Nightscout) directly, with no tab strip.
 *
 * v1.25.7 — the delivery CHANNELS (Telegram / ntfy / Web Push / Webhook /
 * Email) move back here from Notifications as a labelled "Delivery channels"
 * group below the connections. Channels are delivery providers — the same
 * conceptual family as Withings / WHOOP / a connected device — not reminder
 * preferences, so they belong with the other integrations. Notifications keeps
 * only the reminder-TYPE content. The group carries `id="channels"` so
 * `/settings/channels` 301-redirects to `/settings/integrations#channels`, and
 * the per-channel anchors (`#telegram`, `#ntfy`, …) inside the panel keep
 * working.
 *
 * `parseOAuthOutcome` / `oauthReasonKey` are re-exported from
 * `connections-panel.tsx` so existing unit-test imports keep resolving.
 */

import { Link2, Send } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { ConnectionsPanel } from "@/components/settings/integrations/connections-panel";
import { NotificationChannelsPanel } from "@/components/settings/integrations/notification-channels-panel";

export {
  parseOAuthOutcome,
  oauthReasonKey,
} from "@/components/settings/integrations/connections-panel";

export function IntegrationsSection() {
  const { t } = useTranslations();

  // v1.18.6 (W9) — the visible page heading + subtitle come from the shared
  // `<SettingsSectionFrame>` in the route; the connections panel is the
  // primary surface, with the delivery-channels group sequenced below it.
  return (
    <div className="space-y-10">
      {/* Connections ("where the data comes from"). The OAuth + device data
          sources. A labelled group header gives this block parity with the
          delivery-channels group below it. */}
      <section className="space-y-4">
        <SettingsCardHeader
          icon={Link2}
          title={t("settings.sections.integrations.connectionsHeading")}
          description={t(
            "settings.sections.integrations.connectionsDescription",
          )}
        />
        <ConnectionsPanel />
      </section>

      {/* Delivery channels ("where it's delivered"). The existing channels
          panel, unchanged. `id="channels"` anchors the group for the
          `/settings/channels` redirect; the per-channel anchors stay inside
          the panel. */}
      <section id="channels" className="scroll-mt-28 space-y-4">
        <SettingsCardHeader
          icon={Send}
          title={t("settings.sections.integrations.channelsHeading")}
          description={t("settings.sections.integrations.channelsDescription")}
        />
        <NotificationChannelsPanel />
      </section>
    </div>
  );
}
