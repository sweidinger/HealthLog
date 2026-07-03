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
export const INTEGRATION_DOCS_BASE = "https://docs.healthlog.dev/integrations";

export type IntegrationDocsProvider =
  | "whoop"
  | "withings"
  | "fitbit"
  | "polar"
  | "oura"
  | "nightscout"
  // v1.27.0 — Google Health runbook (docs.healthlog.dev/integrations/google-health).
  | "google-health";

export function integrationDocsHref(provider: IntegrationDocsProvider): string {
  return `${INTEGRATION_DOCS_BASE}/${provider}`;
}

/**
 * v1.18.7 (Wave F) — the one description skeleton every integration card paints:
 * a WHITE primary sentence (`${i18nPrefix}Description`), then a GREY secondary
 * sentence (`${i18nPrefix}DescriptionSecondary`) that ends with the setup-guide
 * link rendered INLINE at the very end of the grey copy — not a standalone
 * bottom-of-card element. Single-sourced so all six cards read as one family.
 */
export function IntegrationCardDescription({
  i18nPrefix,
  provider,
}: {
  i18nPrefix: string;
  provider: IntegrationDocsProvider;
}) {
  const { t } = useTranslations();
  return (
    <>
      <p className="text-foreground">{t(`${i18nPrefix}Description`)}</p>
      <p className="text-muted-foreground/80">
        {t(`${i18nPrefix}DescriptionSecondary`)}{" "}
        <a
          href={integrationDocsHref(provider)}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`${provider}-setup-guide`}
          data-slot="integration-setup-guide"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 underline underline-offset-2"
        >
          {t("settings.integrationSetupGuide")}
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      </p>
    </>
  );
}
