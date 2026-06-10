"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Activity,
  AlertCircle,
  HeartPulse,
  Link2,
  Loader2,
  RefreshCw,
  Save,
  Unlink,
} from "lucide-react";

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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { TestConnectionButton } from "@/components/settings/test-connection-button";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { IntegrationStatusPill } from "@/components/settings/integration-status-pill";
import type { IntegrationPillState } from "@/components/settings/integration-status-pill";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import {
  invalidateKeys,
  measurementDependentKeys,
  queryKeys,
} from "@/lib/query-keys";

// v1.4.15 Phase B2: shared status payload for both integration cards.
// v1.4.19 Phase A5: the redundant in-card status banner is gone — the
// IntegrationStatusPill now owns state + last-sync presentation, and
// the actionable error message is shown inline above the action row.
type IntegrationKey = "withings" | "whoop" | "fitbit" | "moodlog";
type IntegrationState =
  | "connected"
  | "error_transient"
  | "error_reauth"
  | "disconnected"
  | "parked";

interface IntegrationStatusViewModel {
  integration: IntegrationKey;
  state: IntegrationState;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  consecutiveFailuresByKind?: {
    transient: number;
    reauth_required: number;
    persistent: number;
  } | null;
  configured?: boolean;
  connected?: boolean;
  connectedAt?: string | null;
  legacyLastSyncedAt?: string | null;
  tokenExpiresAt?: string | null;
  tokenExpired?: boolean | null;
  enabled?: boolean;
  // Withings activity-scope reconnect banner.
  scope?: string | null;
  hasActivityScope?: boolean;
  // WHOOP / Fitbit backfill-in-progress note.
  backfillCompleted?: boolean | null;
  // moodLog webhook secret + entry count.
  webhookSecret?: string | null;
  entryCount?: number;
}

interface IntegrationStatusEnvelope {
  threshold: number;
  integrations: IntegrationStatusViewModel[];
}

/**
 * Shared status fetch for the Settings → Integrations card. Returns
 * the per-integration view-model AND the global threshold so the
 * "{n}/{threshold} consecutive failures" string in the UI is single-
 * sourced from the server.
 */
function useIntegrationStatuses(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.integrationsStatus(),
    queryFn: async () => {
      const res = await fetch("/api/integrations/status");
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as IntegrationStatusEnvelope;
    },
    enabled,
    refetchOnWindowFocus: true,
  });
}

function pickStatus(
  envelope: IntegrationStatusEnvelope | undefined,
  integration: IntegrationKey,
): IntegrationStatusViewModel | undefined {
  return envelope?.integrations.find((i) => i.integration === integration);
}

/**
 * Collapse the API's five-state machine into the four states the
 * pill UI cares about. `error_transient` and `error_reauth` both
 * surface as the same "Error — reconnect" pill, the actionable
 * difference (whether the user must reconnect vs wait for the next
 * retry) is conveyed via the inline error text underneath. `parked`
 * (v1.4.43 W14) is its own pill state — the integration has been
 * disabled after 24h of persistent failures and needs an explicit
 * "Wieder verbinden" click to resume.
 */
function pillStateFor(
  status: IntegrationStatusViewModel | undefined,
): IntegrationPillState {
  if (!status) return "disconnected";
  switch (status.state) {
    case "connected":
      return "connected";
    case "error_transient":
      // v1.4.43 W4 H3 — a `persistent` failure-kind streak (Withings
      // rate-limit 601 / contract-mismatch 293/294) maps to the same
      // `error_transient` DB state as a normal retryable failure but
      // tells the user a different story: the access token still
      // works, the upstream is responding with a non-recoverable
      // status. Surfacing it as a "warning" pill (orange) instead of
      // the red "Fehler — neu verbinden" stops the user from clicking
      // reconnect ten times when reconnect can't fix it.
      if ((status.consecutiveFailuresByKind?.persistent ?? 0) > 0) {
        return "warning";
      }
      return "error";
    case "error_reauth":
      return "error";
    case "parked":
      return "parked";
    case "disconnected":
      return "disconnected";
  }
}

/**
 * Inline actionable error message that surfaces under the pill when a
 * sync attempt failed. The pill conveys "something is wrong"; this
 * line tells the user *what* is wrong so they can act on it. Keeping
 * it deliberately small (one icon + one line) so it doesn't recreate
 * the v1.4.18 redundant banner the maintainer removed.
 */
function IntegrationErrorMessage({ message }: { message: string }) {
  return (
    <p
      data-testid="integration-error-message"
      className="text-destructive flex items-start gap-1.5 text-xs"
    >
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">{message}</span>
    </p>
  );
}

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
        <h1
          id="settings-section-integrations-title"
          className="text-2xl font-semibold tracking-tight"
        >
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
            className="text-primary underline-offset-2 hover:underline"
            data-slot="integrations-sources-cross-link"
          >
            {t("settings.integrationsSourcesHintLink")}
          </Link>
        </p>
      </header>

      <WithingsCard viewModel={withingsViewModel} />
      <WhoopCard viewModel={whoopViewModel} />
      <FitbitCard viewModel={fitbitViewModel} />
    </section>
  );
}

function WithingsCard({
  viewModel,
}: {
  viewModel: IntegrationStatusViewModel | undefined;
}) {
  const { t } = useTranslations();
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncMsgType, setSyncMsgType] = useState<"success" | "error" | null>(
    null,
  );
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [credsSaving, setCredsSaving] = useState(false);
  const [credsMsg, setCredsMsg] = useState<string | null>(null);
  const [credsMsgType, setCredsMsgType] = useState<"success" | "error" | null>(
    null,
  );
  const queryClient = useQueryClient();

  // v1.12.1 — the Withings status is read off the consolidated
  // /api/integrations/status envelope (the `viewModel` prop). The
  // per-card /api/withings/status round-trip is gone; the envelope
  // carries every field this card renders (connected / configured /
  // last-sync / activity scope).
  const status = viewModel;

  const disconnect = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/withings/disconnect", { method: "POST" });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.withings() });
      queryClient.invalidateQueries({ queryKey: queryKeys.integrationsStatus() });
    },
  });

  // v1.4.43 W14 — clear a parked integration via the resume endpoint.
  // The CTA is rendered inside the parked banner below; success
  // invalidates both the per-card status (so the pill flips back to
  // connected immediately) and the cross-integration envelope (so any
  // other view picks up the change on its next focus).
  const resume = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/integrations/withings/resume", {
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as {
        resumed: boolean;
        wasParked: boolean;
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.withings() });
      queryClient.invalidateQueries({ queryKey: queryKeys.integrationsStatus() });
    },
  });

  async function handleSync(fullSync = false) {
    setSyncing(true);
    setSyncMsg(null);
    setSyncMsgType(null);
    try {
      const res = await fetch("/api/withings/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullSync }),
      });
      const json = await res.json();
      if (res.ok) {
        setSyncMsg(
          fullSync
            ? t("settings.withingsFullSyncResult", {
                count: json.data.imported,
              })
            : t("settings.withingsSyncResult", { count: json.data.imported }),
        );
        setSyncMsgType("success");
        void invalidateKeys(queryClient, measurementDependentKeys);
        queryClient.invalidateQueries({ queryKey: queryKeys.integrationsStatus() });
      } else {
        setSyncMsg(json.error || t("settings.withingsSyncFailed"));
        setSyncMsgType("error");
      }
    } catch {
      setSyncMsg(t("settings.withingsSyncFailed"));
      setSyncMsgType("error");
    } finally {
      setSyncing(false);
    }
  }

  async function handleSaveCredentials(e: React.FormEvent) {
    e.preventDefault();
    setCredsSaving(true);
    setCredsMsg(null);
    setCredsMsgType(null);

    try {
      const res = await fetch("/api/withings/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
        }),
      });

      if (res.ok) {
        setCredsMsg(t("settings.withingsCredentialsSaved"));
        setCredsMsgType("success");
        setClientId("");
        setClientSecret("");
        queryClient.invalidateQueries({ queryKey: queryKeys.withings() });
      } else {
        try {
          const json = await res.json();
          setCredsMsg(json.error || t("settings.savingError"));
        } catch {
          setCredsMsg(t("settings.savingError"));
        }
        setCredsMsgType("error");
      }
    } catch {
      setCredsMsg(t("common.networkError"));
      setCredsMsgType("error");
    }
    setCredsSaving(false);
  }

  // The pill state derives from the cross-integration status
  // envelope. `legacyLastSyncedAt` is the connection row's own
  // last-sync timestamp (carried in the same envelope) so the pill
  // still paints a fresh "X min ago" right after a manual sync once
  // the envelope refetches. When the envelope hasn't answered yet we
  // fall back to "disconnected" so the card never renders status-less.
  const pillState: IntegrationPillState = status?.connected
    ? pillStateFor(viewModel)
    : "disconnected";
  const pillLastSyncAt =
    status?.legacyLastSyncedAt ?? viewModel?.lastSuccessAt ?? null;
  // v1.4.43 W14 — `parked` and `error` both want the underlying error
  // message surfaced under the pill (the pill says "what" — the
  // message says "why"). Other states leave the inline line off.
  const errorMessage =
    (pillState === "error" || pillState === "parked") && viewModel?.lastError
      ? viewModel.lastError
      : null;

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <SettingsCardHeader
        icon={Link2}
        title={t("settings.withings")}
        description={t("settings.withingsDescription")}
        status={
          <IntegrationStatusPill state={pillState} lastSyncAt={pillLastSyncAt} />
        }
      />

      <hr
        data-testid="integration-card-divider"
        className="border-border/60 mt-4"
      />

      <div className="mt-4 space-y-4">
        {errorMessage && <IntegrationErrorMessage message={errorMessage} />}
        {/* v1.4.25 W5d — Withings activity-scope reconnect banner.
            Only paints when (a) the user has an active Withings
            connection (so the credentials are already saved + a token
            exists) AND (b) the persisted scope is missing
            `user.activity`. Reconnecting takes the user through the
            standard /api/withings/connect → Withings → callback flow;
            the callback persists the upgraded scope and the banner
            vanishes on the next status poll. */}
        {status?.connected && status?.hasActivityScope === false && (
          <a
            href="/api/withings/connect"
            data-testid="withings-reconnect-banner"
            className="border-warning/30 bg-warning/10 text-warning-foreground hover:bg-warning/20 block rounded-md border px-3 py-2 text-sm transition-colors"
          >
            <span className="font-medium">
              {t("settings.integrations.withings.reconnect.banner.title")}
            </span>
            <span className="text-muted-foreground block text-xs">
              {t("settings.integrations.withings.reconnect.banner.body")}
            </span>
            <span className="text-primary mt-1 inline-block text-xs font-medium">
              {t("settings.integrations.withings.reconnect.banner.action")}
              {" →"}
            </span>
          </a>
        )}
        {/* v1.4.43 W14 — parked-integration resume CTA. Surfaces only
            when the row state is `parked` (>24h of persistent
            failures). The button POSTs to /api/integrations/withings/
            resume which calls `resumeIntegrationFromPark`; on success
            the per-card status invalidates and the pill flips back to
            connected without a page refresh. The button is the
            primary action the user can take from this card — wider
            tap target than the inline action row so it's reachable
            on a Pixel 5 viewport. */}
        {pillState === "parked" && (
          <div
            data-testid="withings-parked-banner"
            className="border-warning/30 bg-warning/10 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <span className="text-warning min-w-0 break-words text-xs">
              {t("settings.integrationPill.parkedReconnect")}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => resume.mutate()}
              disabled={resume.isPending}
              data-testid="withings-resume-button"
              className="min-h-11"
            >
              {resume.isPending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              ) : (
                <Link2 className="mr-1 h-3.5 w-3.5" />
              )}
              {t("settings.integrationPill.resumeCta")}
            </Button>
          </div>
        )}
        {resume.isError && (
          <p
            role="alert"
            className="text-destructive text-xs"
            data-testid="withings-resume-error"
          >
            {t("settings.integrationPill.resumeError")}
          </p>
        )}
        {resume.isSuccess && resume.data?.wasParked && (
          <p
            role="status"
            className="text-success text-xs"
            data-testid="withings-resume-success"
          >
            {t("settings.integrationPill.resumeSuccess")}
          </p>
        )}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">
            {t("settings.withingsCredentials")}
          </h3>
          <form onSubmit={handleSaveCredentials} className="space-y-3">
            {/* v1.4.27 MB7 / CF-53 — the credentials grid drops from
                a 3-column row (client-id / secret / save) to a
                2-column row of inputs at `sm:`, with the Save button
                lifted out into its own row below. The previous
                "invisible Label" hack to align the button with the
                input baselines fell apart on Galaxy Fold; lifting
                the button into a dedicated `flex justify-end` row
                gives it consistent placement on every viewport and
                lets the input pair span the full width. */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="w-clientid">
                  {t("settings.withingsClientId")}
                </Label>
                <Input
                  id="w-clientid"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder={
                    status?.configured
                      ? t("settings.withingsCredentialsSavedPlaceholder")
                      : t("settings.withingsClientId")
                  }
                  maxLength={200}
                  autoComplete="off"
                  inputMode="text"
                  spellCheck={false}
                  autoCapitalize="none"
                  enterKeyHint="next"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="w-secret">
                  {t("settings.withingsClientSecret")}
                </Label>
                <PasswordInput
                  id="w-secret"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={
                    status?.configured
                      ? t("settings.withingsCredentialsSavedPlaceholderSecret")
                      : t("settings.withingsClientSecret")
                  }
                  maxLength={200}
                  autoComplete="off"
                  inputMode="text"
                  spellCheck={false}
                  autoCapitalize="none"
                  enterKeyHint="done"
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                type="submit"
                variant="outline"
                size="sm"
                className="min-h-11 w-full sm:w-auto"
                disabled={
                  credsSaving || !clientId.trim() || !clientSecret.trim()
                }
              >
                {credsSaving ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Save className="mr-1 h-3.5 w-3.5" />
                )}
                {t("settings.withingsSaveCredentials")}
              </Button>
            </div>
            {credsMsg && (
              <p
                role="alert"
                className={`text-sm ${credsMsgType === "success" ? "text-success" : "text-destructive"}`}
              >
                {credsMsg}
              </p>
            )}
          </form>
        </div>

        {status?.connected ? (
          <>
            {/* v1.4.27 MB7 / CF-57 — the action row already wraps via
                `flex-wrap`, but on Pixel 5 the four AlertDialog +
                test-connection triggers each took a fractional slot
                that read jagged. Force each button to a `min-w-[10rem]`
                on `<sm` so they stack two per row at most and fill
                their column cleanly. Tablet+ keeps the inline row. */}
            <div className="flex flex-wrap items-start gap-2 [&>*]:min-w-[10rem] sm:[&>*]:min-w-0">
              <Button
                variant="outline"
                size="sm"
                className="min-h-11"
                onClick={() => handleSync(false)}
                disabled={syncing}
              >
                {syncing ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                )}
                {t("settings.withingsSync")}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11"
                    disabled={syncing}
                  >
                    {syncing ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                    ) : (
                      <RefreshCw className="mr-1 h-3.5 w-3.5" />
                    )}
                    {t("settings.withingsFullSync")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.withingsFullSyncTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.withingsFullSyncDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => handleSync(true)}>
                      {t("settings.withingsSynchronize")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <TestConnectionButton
                endpoint="/api/integrations/withings/test"
                disabled={!status?.connected}
              />
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive min-h-11"
                  >
                    <Unlink className="mr-1 h-3.5 w-3.5" />
                    {t("settings.withingsDisconnect")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.withingsDisconnectTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.withingsDisconnectDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => disconnect.mutate()}
                    >
                      {t("settings.withingsDisconnect")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
            {syncMsg && (
              <p
                role="alert"
                className={`text-sm ${syncMsgType === "success" ? "text-success" : "text-destructive"}`}
              >
                {syncMsg}
              </p>
            )}
          </>
        ) : status?.configured ? (
          <Button
            variant="outline"
            onClick={() => {
              window.location.href = "/api/withings/connect";
            }}
          >
            <Link2 className="mr-2 h-4 w-4" />
            {t("settings.withingsConnect")}
          </Button>
        ) : (
          <div className="bg-muted/50 text-muted-foreground rounded-lg p-3 text-sm">
            {t("settings.withingsNoCredentials")}
          </div>
        )}
      </div>
    </div>
  );
}

function WhoopCard({
  viewModel,
}: {
  viewModel: IntegrationStatusViewModel | undefined;
}) {
  const { t } = useTranslations();
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncMsgType, setSyncMsgType] = useState<"success" | "error" | null>(
    null,
  );
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [credsSaving, setCredsSaving] = useState(false);
  const [credsMsg, setCredsMsg] = useState<string | null>(null);
  const [credsMsgType, setCredsMsgType] = useState<"success" | "error" | null>(
    null,
  );
  const queryClient = useQueryClient();

  // v1.12.1 — read off the consolidated /api/integrations/status
  // envelope; the per-card /api/whoop/status round-trip is gone.
  const status = viewModel;

  const disconnect = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/whoop/disconnect", { method: "POST" });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.whoop() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.integrationsStatus(),
      });
    },
  });

  // Clear a parked integration via the resume endpoint. The CTA is
  // rendered inside the parked banner below; success invalidates both
  // the per-card status (so the pill flips back to connected
  // immediately) and the cross-integration envelope (so any other view
  // picks up the change on its next focus).
  const resume = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/integrations/whoop/resume", {
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as {
        resumed: boolean;
        wasParked: boolean;
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.whoop() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.integrationsStatus(),
      });
    },
  });

  async function handleSync(fullSync = false) {
    setSyncing(true);
    setSyncMsg(null);
    setSyncMsgType(null);
    try {
      const res = await fetch("/api/whoop/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullSync }),
      });
      const json = await res.json();
      if (res.ok) {
        setSyncMsg(t("settings.whoopSyncResult", { count: json.data.imported }));
        setSyncMsgType("success");
        void invalidateKeys(queryClient, measurementDependentKeys);
        queryClient.invalidateQueries({ queryKey: queryKeys.whoop() });
        queryClient.invalidateQueries({
          queryKey: queryKeys.integrationsStatus(),
        });
      } else {
        setSyncMsg(json.error || t("settings.whoopSyncFailed"));
        setSyncMsgType("error");
      }
    } catch {
      setSyncMsg(t("settings.whoopSyncFailed"));
      setSyncMsgType("error");
    } finally {
      setSyncing(false);
    }
  }

  async function handleSaveCredentials(e: React.FormEvent) {
    e.preventDefault();
    setCredsSaving(true);
    setCredsMsg(null);
    setCredsMsgType(null);

    try {
      const res = await fetch("/api/whoop/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
        }),
      });

      if (res.ok) {
        setCredsMsg(t("settings.whoopCredentialsSaved"));
        setCredsMsgType("success");
        setClientId("");
        setClientSecret("");
        queryClient.invalidateQueries({ queryKey: queryKeys.whoop() });
      } else {
        try {
          const json = await res.json();
          setCredsMsg(json.error || t("settings.savingError"));
        } catch {
          setCredsMsg(t("settings.savingError"));
        }
        setCredsMsgType("error");
      }
    } catch {
      setCredsMsg(t("common.networkError"));
      setCredsMsgType("error");
    }
    setCredsSaving(false);
  }

  const pillState: IntegrationPillState = status?.connected
    ? pillStateFor(viewModel)
    : "disconnected";
  const pillLastSyncAt =
    status?.legacyLastSyncedAt ?? viewModel?.lastSuccessAt ?? null;
  const errorMessage =
    (pillState === "error" || pillState === "parked") && viewModel?.lastError
      ? viewModel.lastError
      : null;

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <SettingsCardHeader
        icon={Activity}
        title={t("settings.whoop")}
        description={
          <>
            <p>{t("settings.whoopDescription")}</p>
            <p className="text-muted-foreground/80">
              {t("settings.whoopOverlapNote")}
            </p>
          </>
        }
        status={
          <IntegrationStatusPill state={pillState} lastSyncAt={pillLastSyncAt} />
        }
      />

      <hr
        data-testid="integration-card-divider"
        className="border-border/60 mt-4"
      />

      <div className="mt-4 space-y-4">
        {errorMessage && <IntegrationErrorMessage message={errorMessage} />}
        {/* Parked-integration resume CTA. Surfaces only when the row
            state is `parked` (>24h of persistent failures). The button
            POSTs to /api/integrations/whoop/resume which calls
            `resumeIntegrationFromPark`; on success the per-card status
            invalidates and the pill flips back to connected without a
            page refresh. Wider tap target than the inline action row so
            it stays reachable on a Pixel 5 viewport. */}
        {pillState === "parked" && (
          <div
            data-testid="whoop-parked-banner"
            className="border-warning/30 bg-warning/10 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <span className="text-warning min-w-0 break-words text-xs">
              {t("settings.integrationPill.parkedReconnect")}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => resume.mutate()}
              disabled={resume.isPending}
              data-testid="whoop-resume-button"
              className="min-h-11"
            >
              {resume.isPending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              ) : (
                <Link2 className="mr-1 h-3.5 w-3.5" />
              )}
              {t("settings.integrationPill.resumeCta")}
            </Button>
          </div>
        )}
        {resume.isError && (
          <p
            role="alert"
            className="text-destructive text-xs"
            data-testid="whoop-resume-error"
          >
            {t("settings.integrationPill.resumeError")}
          </p>
        )}
        {resume.isSuccess && resume.data?.wasParked && (
          <p
            role="status"
            className="text-success text-xs"
            data-testid="whoop-resume-success"
          >
            {t("settings.integrationPill.resumeSuccess")}
          </p>
        )}

        <div className="space-y-3">
          <h3 className="text-sm font-semibold">
            {t("settings.whoopCredentials")}
          </h3>
          <p className="text-muted-foreground text-xs">
            {t("settings.whoopCredentialsHelp")}
          </p>
          <form onSubmit={handleSaveCredentials} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="whoop-clientid">
                  {t("settings.whoopClientId")}
                </Label>
                <Input
                  id="whoop-clientid"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder={
                    status?.configured
                      ? t("settings.whoopCredentialsSavedPlaceholder")
                      : t("settings.whoopClientId")
                  }
                  maxLength={200}
                  autoComplete="off"
                  inputMode="text"
                  spellCheck={false}
                  autoCapitalize="none"
                  enterKeyHint="next"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="whoop-secret">
                  {t("settings.whoopClientSecret")}
                </Label>
                <PasswordInput
                  id="whoop-secret"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={
                    status?.configured
                      ? t("settings.whoopCredentialsSavedPlaceholderSecret")
                      : t("settings.whoopClientSecret")
                  }
                  maxLength={200}
                  autoComplete="off"
                  inputMode="text"
                  spellCheck={false}
                  autoCapitalize="none"
                  enterKeyHint="done"
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                type="submit"
                variant="outline"
                size="sm"
                className="min-h-11 w-full sm:w-auto"
                disabled={
                  credsSaving || !clientId.trim() || !clientSecret.trim()
                }
              >
                {credsSaving ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Save className="mr-1 h-3.5 w-3.5" />
                )}
                {t("settings.whoopSaveCredentials")}
              </Button>
            </div>
            {credsMsg && (
              <p
                role="alert"
                className={`text-sm ${credsMsgType === "success" ? "text-success" : "text-destructive"}`}
              >
                {credsMsg}
              </p>
            )}
          </form>
        </div>

        {status?.connected ? (
          <>
            <div className="flex flex-wrap items-start gap-2 [&>*]:min-w-[10rem] sm:[&>*]:min-w-0">
              <Button
                variant="outline"
                size="sm"
                className="min-h-11"
                onClick={() => handleSync(false)}
                disabled={syncing}
              >
                {syncing ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                )}
                {t("settings.whoopSync")}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11"
                    disabled={syncing}
                  >
                    {syncing ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                    ) : (
                      <RefreshCw className="mr-1 h-3.5 w-3.5" />
                    )}
                    {t("settings.whoopFullSync")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.whoopFullSyncTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.whoopFullSyncDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => handleSync(true)}>
                      {t("settings.whoopSynchronize")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <TestConnectionButton
                endpoint="/api/integrations/whoop/test"
                disabled={!status?.connected}
              />
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive min-h-11"
                  >
                    <Unlink className="mr-1 h-3.5 w-3.5" />
                    {t("settings.whoopDisconnect")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.whoopDisconnectTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.whoopDisconnectDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => disconnect.mutate()}
                    >
                      {t("settings.whoopDisconnect")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
            {status?.backfillCompleted === false && (
              <p className="text-muted-foreground text-xs">
                {t("settings.whoopBackfillInProgress")}
              </p>
            )}
            {syncMsg && (
              <p
                role="alert"
                className={`text-sm ${syncMsgType === "success" ? "text-success" : "text-destructive"}`}
              >
                {syncMsg}
              </p>
            )}
          </>
        ) : status?.configured ? (
          <Button
            variant="outline"
            onClick={() => {
              window.location.href = "/api/whoop/connect";
            }}
          >
            <Link2 className="mr-2 h-4 w-4" />
            {t("settings.whoopConnect")}
          </Button>
        ) : (
          <div className="bg-muted/50 text-muted-foreground rounded-lg p-3 text-sm">
            {t("settings.whoopNoCredentials")}
          </div>
        )}
      </div>
    </div>
  );
}

// v1.12.0 — Google Health (Fitbit & Pixel) card. Mirrors the WHOOP card: a
// BYO-key credentials form first, then an OAuth connect, then the
// sync/test/disconnect action row + parked-resume banner. v1.12.1 — status
// reads off the consolidated /api/integrations/status envelope (the per-card
// /api/fitbit/status round-trip is gone); the pill/error/parked state comes off
// the same view-model like WHOOP.
function FitbitCard({
  viewModel,
}: {
  viewModel: IntegrationStatusViewModel | undefined;
}) {
  const { t } = useTranslations();
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncMsgType, setSyncMsgType] = useState<"success" | "error" | null>(
    null,
  );
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [credsSaving, setCredsSaving] = useState(false);
  const [credsMsg, setCredsMsg] = useState<string | null>(null);
  const [credsMsgType, setCredsMsgType] = useState<"success" | "error" | null>(
    null,
  );
  const queryClient = useQueryClient();

  const status = viewModel;

  const disconnect = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/fitbit/disconnect", { method: "POST" });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.fitbit() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.integrationsStatus(),
      });
    },
  });

  // Clear a parked integration via the resume endpoint. The CTA is
  // rendered inside the parked banner below; success invalidates both
  // the per-card status (so the pill flips back to connected
  // immediately) and the cross-integration envelope (so any other view
  // picks up the change on its next focus).
  const resume = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/integrations/fitbit/resume", {
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).data as {
        resumed: boolean;
        wasParked: boolean;
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.fitbit() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.integrationsStatus(),
      });
    },
  });

  async function handleSync(fullSync = false) {
    setSyncing(true);
    setSyncMsg(null);
    setSyncMsgType(null);
    try {
      const res = await fetch("/api/fitbit/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullSync }),
      });
      const json = await res.json();
      if (res.ok) {
        setSyncMsg(
          t("settings.fitbitSyncResult", { count: json.data.imported }),
        );
        setSyncMsgType("success");
        void invalidateKeys(queryClient, measurementDependentKeys);
        queryClient.invalidateQueries({ queryKey: queryKeys.fitbit() });
        queryClient.invalidateQueries({
          queryKey: queryKeys.integrationsStatus(),
        });
      } else {
        setSyncMsg(json.error || t("settings.fitbitSyncFailed"));
        setSyncMsgType("error");
      }
    } catch {
      setSyncMsg(t("settings.fitbitSyncFailed"));
      setSyncMsgType("error");
    } finally {
      setSyncing(false);
    }
  }

  async function handleSaveCredentials(e: React.FormEvent) {
    e.preventDefault();
    setCredsSaving(true);
    setCredsMsg(null);
    setCredsMsgType(null);

    try {
      const res = await fetch("/api/fitbit/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
        }),
      });

      if (res.ok) {
        setCredsMsg(t("settings.fitbitCredentialsSaved"));
        setCredsMsgType("success");
        setClientId("");
        setClientSecret("");
        queryClient.invalidateQueries({ queryKey: queryKeys.fitbit() });
      } else {
        try {
          const json = await res.json();
          setCredsMsg(json.error || t("settings.savingError"));
        } catch {
          setCredsMsg(t("settings.savingError"));
        }
        setCredsMsgType("error");
      }
    } catch {
      setCredsMsg(t("common.networkError"));
      setCredsMsgType("error");
    }
    setCredsSaving(false);
  }

  const pillState: IntegrationPillState = status?.connected
    ? pillStateFor(viewModel)
    : "disconnected";
  const pillLastSyncAt =
    status?.legacyLastSyncedAt ?? viewModel?.lastSuccessAt ?? null;
  const errorMessage =
    (pillState === "error" || pillState === "parked") && viewModel?.lastError
      ? viewModel.lastError
      : null;

  return (
    <div
      data-testid="fitbit-card"
      className="bg-card border-border rounded-xl border p-6"
    >
      <SettingsCardHeader
        icon={HeartPulse}
        title={t("settings.fitbit")}
        titleAccessory={
          <>
            <span className="bg-muted text-foreground rounded-full px-2 py-0.5 text-[0.6875rem] font-medium">
              {t("settings.fitbitTag")}
            </span>
            <Badge
              variant="outline"
              data-testid="fitbit-experimental-badge"
              className="border-amber-500/50 text-amber-600 dark:text-amber-400"
            >
              {t("settings.fitbitExperimentalBadge")}
            </Badge>
          </>
        }
        description={
          <>
            <p>{t("settings.fitbitDescription")}</p>
            <p
              data-testid="fitbit-experimental-note"
              className="text-muted-foreground/80"
            >
              {t("settings.fitbitExperimentalNote")}
            </p>
            <p className="text-muted-foreground/80">
              {t("settings.fitbitOverlapNote")}
            </p>
          </>
        }
        status={
          <IntegrationStatusPill state={pillState} lastSyncAt={pillLastSyncAt} />
        }
      />

      <hr
        data-testid="integration-card-divider"
        className="border-border/60 mt-4"
      />

      <div className="mt-4 space-y-4">
        {errorMessage && <IntegrationErrorMessage message={errorMessage} />}
        {/* Parked-integration resume CTA. Surfaces only when the row
            state is `parked` (>24h of persistent failures). The button
            POSTs to /api/integrations/fitbit/resume which calls
            `resumeIntegrationFromPark`; on success the per-card status
            invalidates and the pill flips back to connected without a
            page refresh. */}
        {pillState === "parked" && (
          <div
            data-testid="fitbit-parked-banner"
            className="border-warning/30 bg-warning/10 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <span className="text-warning min-w-0 break-words text-xs">
              {t("settings.integrationPill.parkedReconnect")}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => resume.mutate()}
              disabled={resume.isPending}
              data-testid="fitbit-resume-button"
              className="min-h-11"
            >
              {resume.isPending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              ) : (
                <Link2 className="mr-1 h-3.5 w-3.5" />
              )}
              {t("settings.integrationPill.resumeCta")}
            </Button>
          </div>
        )}
        {resume.isError && (
          <p
            role="alert"
            className="text-destructive text-xs"
            data-testid="fitbit-resume-error"
          >
            {t("settings.integrationPill.resumeError")}
          </p>
        )}
        {resume.isSuccess && resume.data?.wasParked && (
          <p
            role="status"
            className="text-success text-xs"
            data-testid="fitbit-resume-success"
          >
            {t("settings.integrationPill.resumeSuccess")}
          </p>
        )}

        <div className="space-y-3">
          <h3 className="text-sm font-semibold">
            {t("settings.fitbitCredentials")}
          </h3>
          <p className="text-muted-foreground text-xs">
            {t("settings.fitbitCredentialsHelp")}
          </p>
          <form onSubmit={handleSaveCredentials} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="fitbit-clientid">
                  {t("settings.fitbitClientId")}
                </Label>
                <Input
                  id="fitbit-clientid"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder={
                    status?.configured
                      ? t("settings.fitbitCredentialsSavedPlaceholder")
                      : t("settings.fitbitClientId")
                  }
                  maxLength={200}
                  autoComplete="off"
                  inputMode="text"
                  spellCheck={false}
                  autoCapitalize="none"
                  enterKeyHint="next"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fitbit-secret">
                  {t("settings.fitbitClientSecret")}
                </Label>
                <PasswordInput
                  id="fitbit-secret"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={
                    status?.configured
                      ? t("settings.fitbitCredentialsSavedPlaceholderSecret")
                      : t("settings.fitbitClientSecret")
                  }
                  maxLength={200}
                  autoComplete="off"
                  inputMode="text"
                  spellCheck={false}
                  autoCapitalize="none"
                  enterKeyHint="done"
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                type="submit"
                variant="outline"
                size="sm"
                className="min-h-11 w-full sm:w-auto"
                disabled={
                  credsSaving || !clientId.trim() || !clientSecret.trim()
                }
              >
                {credsSaving ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Save className="mr-1 h-3.5 w-3.5" />
                )}
                {t("settings.fitbitSaveCredentials")}
              </Button>
            </div>
            {credsMsg && (
              <p
                role="alert"
                className={`text-sm ${credsMsgType === "success" ? "text-success" : "text-destructive"}`}
              >
                {credsMsg}
              </p>
            )}
          </form>
        </div>

        {status?.connected ? (
          <>
            <div className="flex flex-wrap items-start gap-2 [&>*]:min-w-[10rem] sm:[&>*]:min-w-0">
              <Button
                variant="outline"
                size="sm"
                className="min-h-11"
                onClick={() => handleSync(false)}
                disabled={syncing}
              >
                {syncing ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                )}
                {t("settings.fitbitSync")}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11"
                    disabled={syncing}
                  >
                    {syncing ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                    ) : (
                      <RefreshCw className="mr-1 h-3.5 w-3.5" />
                    )}
                    {t("settings.fitbitFullSync")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.fitbitFullSyncTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.fitbitFullSyncDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => handleSync(true)}>
                      {t("settings.fitbitSynchronize")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <TestConnectionButton
                endpoint="/api/integrations/fitbit/test"
                disabled={!status?.connected}
              />
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive min-h-11"
                  >
                    <Unlink className="mr-1 h-3.5 w-3.5" />
                    {t("settings.fitbitDisconnect")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.fitbitDisconnectTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.fitbitDisconnectDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => disconnect.mutate()}
                    >
                      {t("settings.fitbitDisconnect")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
            {status?.backfillCompleted === false && (
              <p className="text-muted-foreground text-xs">
                {t("settings.fitbitBackfillInProgress")}
              </p>
            )}
            {syncMsg && (
              <p
                role="alert"
                className={`text-sm ${syncMsgType === "success" ? "text-success" : "text-destructive"}`}
              >
                {syncMsg}
              </p>
            )}
          </>
        ) : status?.configured ? (
          <Button
            variant="outline"
            onClick={() => {
              window.location.href = "/api/fitbit/connect";
            }}
          >
            <Link2 className="mr-2 h-4 w-4" />
            {t("settings.fitbitConnect")}
          </Button>
        ) : (
          <div className="bg-muted/50 text-muted-foreground rounded-lg p-3 text-sm">
            {t("settings.fitbitNoCredentials")}
          </div>
        )}
      </div>
    </div>
  );
}
