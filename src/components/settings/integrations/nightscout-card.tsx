"use client";

// v1.17.0 — Nightscout CGM integration card. Unlike WHOOP / Fitbit (OAuth,
// BYO-key), Nightscout is a URL + token the self-hoster pastes once: the user
// runs their own instance and HealthLog pulls continuous glucose off it. The
// card has its own status read (`/api/nightscout/status`) rather than the
// consolidated envelope. Warm copy, mobile-first, the private-network opt-in
// toggle maps to `nightscoutAllowPrivateHost`.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Link2, Loader2, Save, Unlink } from "lucide-react";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Switch } from "@/components/ui/switch";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import {
  IntegrationStatusPill,
  type IntegrationPillState,
} from "@/components/settings/integration-status-pill";
import { apiFetchRaw, apiGet, apiPost } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, measurementDependentKeys, queryKeys } from "@/lib/query-keys";

import { IntegrationErrorMessage } from "./shared";

interface NightscoutStatus {
  connected: boolean;
  configured: boolean;
  hasToken?: boolean;
  allowPrivateHost?: boolean;
  state?: "connected" | "error_transient" | "error_reauth" | "disconnected" | "parked";
  lastSuccessAt?: string | null;
  lastAttemptAt?: string | null;
  lastError?: string | null;
}

/** Map the shared ledger state onto the pill's display state. */
function pillStateFor(status: NightscoutStatus | undefined): IntegrationPillState {
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

export function NightscoutCard({ enabled = true }: { enabled?: boolean }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [allowPrivateHost, setAllowPrivateHost] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  const { data: status } = useQuery({
    queryKey: queryKeys.nightscoutStatus(),
    queryFn: async () => apiGet<NightscoutStatus>("/api/nightscout/status"),
    enabled,
    refetchOnWindowFocus: true,
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      await apiPost("/api/nightscout/disconnect");
    },
    onSuccess: () => {
      setUrl("");
      setToken("");
      setAllowPrivateHost(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.nightscout() });
    },
  });

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    setMsgType(null);
    try {
      const res = await apiFetchRaw("/api/nightscout/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          token: token.trim(),
          allowPrivateHost,
        }),
      });
      if (res.ok) {
        setMsg(t("settings.nightscoutConnected"));
        setMsgType("success");
        setToken("");
        void invalidateKeys(queryClient, measurementDependentKeys);
        queryClient.invalidateQueries({ queryKey: queryKeys.nightscout() });
      } else {
        let detail = t("settings.nightscoutConnectFailed");
        try {
          const json = await res.json();
          if (json.error) detail = json.error;
        } catch {
          // keep the generic message
        }
        setMsg(detail);
        setMsgType("error");
      }
    } catch {
      setMsg(t("common.networkError"));
      setMsgType("error");
    }
    setSaving(false);
  }

  const pillState = pillStateFor(status);
  const errorMessage =
    (pillState === "error" || pillState === "parked") && status?.lastError
      ? status.lastError
      : null;

  return (
    <div
      data-testid="nightscout-card"
      className="bg-card border-border rounded-xl border p-4 sm:p-6"
    >
      <SettingsCardHeader
        icon={Activity}
        title={t("settings.nightscout")}
        titleAccessory={
          <span className="bg-muted text-foreground rounded-full px-2 py-0.5 text-[0.6875rem] font-medium">
            {t("settings.nightscoutTag")}
          </span>
        }
        description={<p>{t("settings.nightscoutDescription")}</p>}
        status={
          <IntegrationStatusPill
            state={pillState}
            lastSyncAt={status?.lastSuccessAt ?? null}
          />
        }
      />

      <hr className="border-border/60 mt-4" />

      <div className="mt-4 space-y-4 pl-7">
        {errorMessage && <IntegrationErrorMessage message={errorMessage} />}

        <p className="text-muted-foreground text-xs">
          {t("settings.nightscoutHelp")}
        </p>

        <form onSubmit={handleConnect} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="nightscout-url">{t("settings.nightscoutUrl")}</Label>
            <Input
              id="nightscout-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={
                status?.configured
                  ? t("settings.nightscoutUrlSavedPlaceholder")
                  : "https://your-site.up.railway.app"
              }
              maxLength={2048}
              autoComplete="off"
              inputMode="url"
              spellCheck={false}
              autoCapitalize="none"
              enterKeyHint="next"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nightscout-token">
              {t("settings.nightscoutToken")}
            </Label>
            <PasswordInput
              id="nightscout-token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                status?.hasToken
                  ? t("settings.nightscoutTokenSavedPlaceholder")
                  : t("settings.nightscoutTokenOptional")
              }
              maxLength={512}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              enterKeyHint="done"
            />
            <p className="text-muted-foreground/80 text-xs">
              {t("settings.nightscoutTokenHelp")}
            </p>
          </div>

          <div className="border-border/60 flex items-start justify-between gap-3 rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="nightscout-private" className="text-sm">
                {t("settings.nightscoutPrivateHost")}
              </Label>
              <p className="text-muted-foreground/80 text-xs">
                {t("settings.nightscoutPrivateHostHelp")}
              </p>
            </div>
            <Switch
              id="nightscout-private"
              checked={allowPrivateHost}
              onCheckedChange={setAllowPrivateHost}
            />
          </div>

          <div className="flex justify-end">
            <Button
              type="submit"
              variant="outline"
              size="sm"
              className="min-h-11 w-full sm:w-auto"
              disabled={saving || !url.trim()}
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              ) : status?.connected ? (
                <Save className="h-3.5 w-3.5" />
              ) : (
                <Link2 className="h-3.5 w-3.5" />
              )}
              {status?.connected
                ? t("settings.nightscoutUpdate")
                : t("settings.nightscoutConnect")}
            </Button>
          </div>

          {msg && (
            <p
              role="alert"
              className={`text-sm ${msgType === "success" ? "text-success" : "text-destructive"}`}
            >
              {msg}
            </p>
          )}
        </form>

        {status?.connected && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive min-h-11"
              >
                <Unlink className="h-3.5 w-3.5" />
                {t("settings.nightscoutDisconnect")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("settings.nightscoutDisconnectTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("settings.nightscoutDisconnectDescription")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => disconnect.mutate()}
                >
                  {t("settings.nightscoutDisconnect")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </div>
  );
}
