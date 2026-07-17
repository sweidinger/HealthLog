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
  | "google-health"
  // v1.28.x — Strava runbook (docs.healthlog.dev/integrations/strava).
  | "strava";

export function integrationDocsHref(provider: IntegrationDocsProvider): string {
  return `${INTEGRATION_DOCS_BASE}/${provider}`;
}

/**
 * The OAuth callback path every BYO-key provider registers against. Every
 * provider's `getRedirectUri()` (`src/lib/{provider}/client.ts`) derives the
 * same shape from `NEXT_PUBLIC_APP_URL` unless an operator overrides it with
 * an explicit `*_REDIRECT_URI` env var — the common case this card targets.
 */
export function integrationCallbackUrl(
  provider: IntegrationDocsProvider,
): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
  return `${base}/api/${provider}/callback`;
}

/**
 * v1.29.x (UX audit H2) — compact 3-step BYO-developer-app guide for the
 * six providers that require a self-hoster to register their own vendor
 * app before an OAuth connect can ever succeed (Withings / WHOOP / Fitbit /
 * Polar / Oura / Strava). The external "Setup guide" link explains the
 * *why*; this inline callout gives the one value every vendor form asks
 * for and the app already knows — the callback URL — so it doesn't have to
 * be reconstructed by hand from the docs. Shown only while the user hasn't
 * saved their own credentials yet; it steps out of the way once configured.
 */
export function IntegrationRedirectGuide({
  provider,
  providerLabel,
}: {
  provider: IntegrationDocsProvider;
  providerLabel: string;
}) {
  const { t } = useTranslations();
  const callbackUrl = integrationCallbackUrl(provider);
  return (
    <div
      className="bg-muted/40 border-border/60 space-y-1.5 rounded-md border p-3 text-xs"
      data-testid={`${provider}-redirect-guide`}
    >
      <p className="text-muted-foreground">
        {t("settings.integrationRedirectGuide.intro", {
          provider: providerLabel,
        })}
      </p>
      <ol className="text-muted-foreground list-decimal space-y-1 pl-4">
        <li>
          {t("settings.integrationRedirectGuide.step1", {
            provider: providerLabel,
          })}
        </li>
        <li>
          {t("settings.integrationRedirectGuide.step2")}{" "}
          <code
            className="bg-background text-foreground rounded px-1 py-0.5 font-mono break-all"
            data-testid={`${provider}-redirect-uri`}
          >
            {callbackUrl}
          </code>
        </li>
        <li>{t("settings.integrationRedirectGuide.step3")}</li>
      </ol>
    </div>
  );
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
      <p className="text-muted-foreground">
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
