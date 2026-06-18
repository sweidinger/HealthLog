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

export {
  parseOAuthOutcome,
  oauthReasonKey,
} from "@/components/settings/integrations/connections-panel";

export function IntegrationsSection() {
  // v1.18.6 (W9) — the visible heading + subtitle and the module tour-replay
  // trigger now live in the shared `<SettingsSectionFrame>` in the route; the
  // body is the connections panel only.
  return <ConnectionsPanel />;
}
