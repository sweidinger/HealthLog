"use client";

/**
 * v1.17.1 — shared "Setup guide" doc-link for every Settings → Integrations
 * card. Each card paints the same affordance: one discreet, external link to
 * the provider's setup runbook ("was eingeben, wo klicken"). Single-sourced
 * here so all six cards (WHOOP / Withings / Fitbit / Polar / Oura / Nightscout)
 * read as one family and the docs host lives in exactly one place.
 *
 * The runbooks themselves are authored separately; this link wires the
 * destination now so a user who is mid-setup always knows where to go.
 */

import { ExternalLink } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";

/**
 * Base for every provider setup runbook. The provider key is appended as a
 * path segment, e.g. `https://docs.healthlog.dev/integrations/whoop`. Kept as
 * a single constant so the host never drifts across cards.
 */
export const INTEGRATION_DOCS_BASE =
  "https://docs.healthlog.dev/integrations";

export type IntegrationDocsProvider =
  | "whoop"
  | "withings"
  | "fitbit"
  | "polar"
  | "oura"
  | "nightscout";

export function integrationDocsHref(provider: IntegrationDocsProvider): string {
  return `${INTEGRATION_DOCS_BASE}/${provider}`;
}

export function IntegrationSetupGuideLink({
  provider,
}: {
  provider: IntegrationDocsProvider;
}) {
  const { t } = useTranslations();
  return (
    <a
      href={integrationDocsHref(provider)}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={`${provider}-setup-guide`}
      data-slot="integration-setup-guide"
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
    >
      {t("settings.integrationSetupGuide")}
      <ExternalLink className="h-3 w-3" aria-hidden="true" />
    </a>
  );
}
