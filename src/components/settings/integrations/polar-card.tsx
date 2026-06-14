"use client";

// v1.17.0 (F4) — Polar AccessLink integration card. Thin wrapper over the
// shared env-based OAuth card.

import { OAuthProviderCard } from "@/components/settings/integrations/oauth-provider-card";
import { queryKeys } from "@/lib/query-keys";

export function PolarCard({ enabled = true }: { enabled?: boolean }) {
  return (
    <OAuthProviderCard
      provider="polar"
      statusQueryKey={queryKeys.polar()}
      i18nPrefix="settings.polar"
      enabled={enabled}
    />
  );
}
