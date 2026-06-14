"use client";

// v1.17.0 (F4) — shared OAuth integration card for env-based providers (Polar,
// Oura). Unlike WHOOP / Fitbit (per-user BYO client id/secret), these use a
// single shared OAuth app the operator configures via env, so the card has NO
// credential inputs — just a connect button that redirects to the provider, a
// status pill off the self-contained status read, and a disconnect action.
// Mirrors the Nightscout card's self-contained status pattern.

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Link2, Unlink, type LucideIcon } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import {
  IntegrationStatusPill,
  type IntegrationPillState,
} from "@/components/settings/integration-status-pill";
import { TestConnectionButton } from "@/components/settings/test-connection-button";
import { apiGet, apiPost } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, measurementDependentKeys } from "@/lib/query-keys";

export interface OAuthProviderStatus {
  connected: boolean;
  configured: boolean;
  available: boolean;
  state?:
    | "connected"
    | "error_transient"
    | "error_reauth"
    | "disconnected"
    | "parked";
  lastSuccessAt?: string | null;
  lastAttemptAt?: string | null;
  lastError?: string | null;
}

function pillStateFor(status: OAuthProviderStatus | undefined): IntegrationPillState {
  if (!status?.connected) return "disconnected";
  switch (status.state) {
    case "parked":
      return "parked";
    case "error_reauth":
      return "error";
    case "error_transient":
      return "warning";
    default:
      return "connected";
  }
}

export interface OAuthProviderCardProps {
  /** Lower-case provider key, used for routes + query keys + testids. */
  provider: "polar" | "oura";
  /** The query-key array shared by the status read + the invalidations. */
  statusQueryKey: readonly unknown[];
  /** i18n key prefix (e.g. `settings.polar`). */
  i18nPrefix: string;
  /** Distinct card glyph, kept in the same size/treatment as the other cards. */
  icon: LucideIcon;
  /** Where this provider's synced data surfaces (e.g. `/insights/sleep`). */
  dataHref: string;
  enabled?: boolean;
}

export function OAuthProviderCard({
  provider,
  statusQueryKey,
  i18nPrefix,
  icon,
  dataHref,
  enabled = true,
}: OAuthProviderCardProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);

  const { data: status } = useQuery({
    queryKey: statusQueryKey,
    queryFn: async () => apiGet<OAuthProviderStatus>(`/api/${provider}/status`),
    enabled,
    refetchOnWindowFocus: true,
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      await apiPost(`/api/${provider}/disconnect`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: statusQueryKey });
    },
  });

  const pillState = pillStateFor(status);
  const errorMessage =
    (pillState === "error" || pillState === "parked") && status?.lastError
      ? status.lastError
      : null;
  const serverUnavailable = status && !status.available;

  function handleConnect() {
    setMsg(null);
    void invalidateKeys(queryClient, measurementDependentKeys);
    window.location.href = `/api/${provider}/connect`;
  }

  return (
    <div
      data-testid={`${provider}-card`}
      className="bg-card border-border rounded-xl border p-4 sm:p-6"
    >
      <SettingsCardHeader
        icon={icon}
        title={t(`${i18nPrefix}`)}
        description={<p>{t(`${i18nPrefix}Description`)}</p>}
        status={
          <IntegrationStatusPill
            state={pillState}
            lastSyncAt={status?.lastSuccessAt ?? null}
          />
        }
      />

      <hr className="border-border/60 mt-4" />

      <div className="mt-4 space-y-4 pl-7">
        {errorMessage && (
          <p
            role="alert"
            data-testid={`${provider}-error`}
            className="text-destructive text-sm break-words"
          >
            {errorMessage}
          </p>
        )}

        {/* Parked-integration resume CTA. Surfaces only when the row state
            is `parked` (>24h of persistent failures). For an env-based OAuth
            provider there are no stored BYO credentials to re-validate — the
            grant itself has to be re-issued, so "reconnect" re-initiates the
            existing connect flow (`/api/<provider>/connect`); a successful
            callback clears the park. Markup matches the WHOOP card byte for
            byte. */}
        {pillState === "parked" && (
          <div
            data-testid={`${provider}-parked-banner`}
            className="border-warning/30 bg-warning/10 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <span className="text-warning min-w-0 text-xs break-words">
              {t("settings.integrationPill.parkedReconnect")}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleConnect}
              disabled={serverUnavailable}
              data-testid={`${provider}-resume-button`}
              className="min-h-11"
            >
              <Link2 className="h-3.5 w-3.5" />
              {t("settings.integrationPill.resumeCta")}
            </Button>
          </div>
        )}

        <p className="text-muted-foreground text-xs">
          {t(`${i18nPrefix}Help`)}
        </p>

        {serverUnavailable && (
          <p
            className="text-muted-foreground/80 text-xs"
            data-testid={`${provider}-unavailable`}
          >
            {t(`${i18nPrefix}Unavailable`)}
          </p>
        )}

        {status?.connected ? (
          <>
            <div className="flex flex-wrap items-start gap-2 [&>*]:min-w-[10rem] sm:[&>*]:min-w-0">
              <TestConnectionButton
                endpoint={`/api/${provider}/test`}
                disabled={!status?.connected}
              />
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive min-h-11"
                    data-testid={`${provider}-disconnect`}
                  >
                    <Unlink className="h-3.5 w-3.5" />
                    {t(`${i18nPrefix}Disconnect`)}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t(`${i18nPrefix}DisconnectTitle`)}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t(`${i18nPrefix}DisconnectDescription`)}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => disconnect.mutate()}
                    >
                      {t(`${i18nPrefix}Disconnect`)}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
            {/* connect→data loop: a discreet link to where this provider's
                readings now surface — doubles as the "your data is richer"
                cue. */}
            <Link
              href={dataHref}
              data-testid={`${provider}-data-link`}
              className="text-primary inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
            >
              {t(`${i18nPrefix}ViewData`)}
              <ArrowRight className="h-3 w-3" />
            </Link>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            className="min-h-11 w-full sm:w-auto"
            disabled={serverUnavailable}
            onClick={handleConnect}
            data-testid={`${provider}-connect`}
          >
            <Link2 className="h-3.5 w-3.5" />
            {t(`${i18nPrefix}Connect`)}
          </Button>
        )}

        {msg && (
          <p role="alert" className="text-destructive text-sm">
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}
