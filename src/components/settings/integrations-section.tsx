"use client";

/**
 * `<IntegrationsSection>` — Settings → Integrations.
 *
 * v1.18.0 (S3) — Integrations is now the one home for every delivery / ingest
 * connection. Three sub-tabs under one nav entry:
 *   1. Connections — Withings / WHOOP / Fitbit / Polar / Oura / Nightscout
 *      (the OAuth + device data sources). See `connections-panel.tsx`.
 *   2. Channels — Telegram / ntfy / Web Push / Webhook / Email plus the live
 *      per-channel status surface (moved here from Settings → Notifications,
 *      where it never belonged: channels are delivery providers, not
 *      reminder preferences). See `notification-channels-panel.tsx`.
 *   3. Sources — the per-metric source-priority + device-type ladders that
 *      decide which connection wins when two report the same metric. Folded in
 *      from the former standalone `/settings/sources` page. See
 *      `sources-section.tsx` (sub-tab mode).
 *
 * `parseOAuthOutcome` / `oauthReasonKey` are re-exported from
 * `connections-panel.tsx` so existing unit-test imports keep resolving.
 */

import { useState } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConnectionsPanel } from "@/components/settings/integrations/connections-panel";
import { NotificationChannelsPanel } from "@/components/settings/integrations/notification-channels-panel";
import { SourcesSection } from "@/components/settings/sources-section";
import { useTranslations } from "@/lib/i18n/context";

export {
  parseOAuthOutcome,
  oauthReasonKey,
} from "@/components/settings/integrations/connections-panel";

type IntegrationsTab = "connections" | "channels" | "sources";

export function IntegrationsSection() {
  const { t } = useTranslations();
  const [tab, setTab] = useState<IntegrationsTab>("connections");

  return (
    <section
      aria-labelledby="settings-section-integrations-title"
      className="space-y-6"
    >
      <header className="space-y-1">
        <h1 id="settings-section-integrations-title" className="sr-only">
          {t("settings.sections.integrations.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.integrations.description")}
        </p>
      </header>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as IntegrationsTab)}
      >
        <TabsList className="w-full sm:w-fit">
          <TabsTrigger value="connections">
            {t("settings.sections.integrations.tabs.connections")}
          </TabsTrigger>
          <TabsTrigger value="channels">
            {t("settings.sections.integrations.tabs.channels")}
          </TabsTrigger>
          <TabsTrigger value="sources">
            {t("settings.sections.integrations.tabs.sources")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="connections">
          <ConnectionsPanel />
        </TabsContent>
        <TabsContent value="channels">
          <NotificationChannelsPanel />
        </TabsContent>
        <TabsContent value="sources">
          <SourcesSection variant="subtab" />
        </TabsContent>
      </Tabs>
    </section>
  );
}
