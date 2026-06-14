"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { FitbitCard } from "@/components/settings/integrations/fitbit-card";
import { NightscoutCard } from "@/components/settings/integrations/nightscout-card";
import {
  pickStatus,
  useIntegrationStatuses,
} from "@/components/settings/integrations/shared";
import { WhoopCard } from "@/components/settings/integrations/whoop-card";
import { WithingsCard } from "@/components/settings/integrations/withings-card";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

/**
 * The Withings OAuth callback (`/api/withings/callback`) redirects back
 * here with `?withings=connected` or `?withings=error&reason=<tag>`.
 * Map every reason tag the callback emits onto a human-readable i18n
 * key (what went wrong + what to do next). Unknown tags fall back to
 * the generic entry so a future callback branch never strands the user
 * with silent params.
 */
const WITHINGS_OAUTH_ERROR_KEYS: Record<string, string> = {
  csrf1: "settings.withingsOauthError.csrf1",
  replay: "settings.withingsOauthError.replay",
  state: "settings.withingsOauthError.state",
  expired: "settings.withingsOauthError.expired",
  cross_user: "settings.withingsOauthError.cross_user",
  nocode: "settings.withingsOauthError.nocode",
  nocreds: "settings.withingsOauthError.nocreds",
  token: "settings.withingsOauthError.token",
};

type WithingsOauthOutcome =
  | { kind: "connected" }
  | { kind: "error"; reason: string };

export function IntegrationsSection() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: integrationStatus } = useIntegrationStatuses(isAuthenticated);

  // OAuth callback handler — reads `?withings=connected|error&reason=…`
  // from the URL (lazy initialiser, same shape as the Codex handler in
  // `ai-section.tsx`) and surfaces the outcome as a toast. Pre-fix the
  // callback set these params and nothing ever read them: a user came
  // back from Withings onto a silently unchanged settings page.
  const [withingsOauthOutcome] = useState<WithingsOauthOutcome | null>(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    const status = params.get("withings");
    if (status === "connected") return { kind: "connected" };
    if (status === "error") {
      return { kind: "error", reason: params.get("reason") ?? "unknown" };
    }
    return null;
  });

  useEffect(() => {
    if (!withingsOauthOutcome) return;
    // Scrub the one-shot params so a reload / bookmark doesn't replay
    // the toast.
    const url = new URL(window.location.href);
    url.searchParams.delete("withings");
    url.searchParams.delete("reason");
    router.replace(`${url.pathname}${url.search}`, { scroll: false });
    if (withingsOauthOutcome.kind === "connected") {
      toast.success(t("settings.withingsOauthConnected"));
      queryClient.invalidateQueries({ queryKey: queryKeys.withings() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.integrationsStatus(),
      });
    } else {
      const reasonKey =
        WITHINGS_OAUTH_ERROR_KEYS[withingsOauthOutcome.reason] ??
        "settings.withingsOauthError.generic";
      toast.error(t("settings.withingsOauthFailed"), {
        description: t(reasonKey),
        duration: 10_000,
      });
    }
  }, [withingsOauthOutcome, router, queryClient, t]);

  const withingsViewModel = pickStatus(integrationStatus, "withings");
  const whoopViewModel = pickStatus(integrationStatus, "whoop");
  const fitbitViewModel = pickStatus(integrationStatus, "fitbit");

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
        {/* Cross-link to Settings → Sources: when two integrations (or
            an integration + manual entry) report the same metric, the
            source-priority ladder decides which value counts — a fact
            newcomers otherwise discover only after a confusing chart. */}
        <p className="text-muted-foreground text-xs">
          {t("settings.integrationsSourcesHint")}{" "}
          <Link
            href="/settings/sources"
            className="text-primary underline underline-offset-2"
            data-slot="integrations-sources-cross-link"
          >
            {t("settings.integrationsSourcesHintLink")}
          </Link>
        </p>
      </header>

      <WithingsCard viewModel={withingsViewModel} />
      <WhoopCard viewModel={whoopViewModel} />
      <FitbitCard viewModel={fitbitViewModel} />
      <NightscoutCard enabled={isAuthenticated} />
    </section>
  );
}
