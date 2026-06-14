"use client";

// v1.17.0 (F4) — Oura Cloud integration card. Thin wrapper over the shared
// env-based OAuth card.

import { OAuthProviderCard } from "@/components/settings/integrations/oauth-provider-card";
import { queryKeys } from "@/lib/query-keys";

export function OuraCard({ enabled = true }: { enabled?: boolean }) {
  return (
    <OAuthProviderCard
      provider="oura"
      statusQueryKey={queryKeys.oura()}
      i18nPrefix="settings.oura"
      enabled={enabled}
    />
  );
}
