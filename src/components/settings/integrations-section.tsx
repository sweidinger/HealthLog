"use client";

/**
 * `<IntegrationsSection>` — Settings → Integrationen.
 *
 * v1.18.1 (D4) — the three sub-tabs (Connections / Channels / Sources) were
 * split into three separate left-side settings entries. The Connections
 * content IS the Integrationen page now: clicking Integrationen shows the
 * OAuth + device data sources (Withings / WHOOP / Fitbit / Polar / Oura /
 * Nightscout) directly, with no tab strip. Channels (delivery providers) and
 * Sources (source weighting) each got their own entry — see
 * `channels-section.tsx` and the standalone `sources` route.
 *
 * `parseOAuthOutcome` / `oauthReasonKey` are re-exported from
 * `connections-panel.tsx` so existing unit-test imports keep resolving.
 */

import { ConnectionsPanel } from "@/components/settings/integrations/connections-panel";
import { useTranslations } from "@/lib/i18n/context";
import { ModuleTourTrigger } from "@/components/onboarding/module-tour-trigger";

export {
  parseOAuthOutcome,
  oauthReasonKey,
} from "@/components/settings/integrations/connections-panel";

export function IntegrationsSection() {
  const { t } = useTranslations();

  return (
    <section
      aria-labelledby="settings-section-integrations-title"
      className="space-y-6"
    >
      {/* v1.18.1 (D0) — section blurb dropped for consistent top alignment. */}
      <header className="flex items-center justify-end">
        <h1 id="settings-section-integrations-title" className="sr-only">
          {t("settings.sections.integrations.title")}
        </h1>
        {/* v1.18.6 — guided-tour re-entry for the integrations module. The
            visible affordance also gives the spotlight a real anchor (the
            section h1 is sr-only). */}
        <span data-tour-id="integrations-hero">
          <ModuleTourTrigger stopId="integrations" />
        </span>
      </header>

      <ConnectionsPanel />
    </section>
  );
}
