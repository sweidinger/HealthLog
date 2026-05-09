"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, Save, Sparkles, Trash2 } from "lucide-react";

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
import { Switch } from "@/components/ui/switch";
import { PasswordInput } from "@/components/settings/password-input";
import { useAuth } from "@/hooks/use-auth";
import { formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";

interface InsightsSettings {
  codexStatus: string;
  codexConnectedAt: string | null;
  hasAdminKey: boolean;
  /** True when the operator has set `CODEX_OAUTH_CLIENT_ID` on this
   *  instance. The UI hides the "Connect with ChatGPT" button when
   *  false to avoid the v1.4.2 dead-end where the click bounced the
   *  user to chatgpt.com without any OAuth flow. */
  codexOauthConfigured?: boolean;
  privacyMode: string;
  lastInsightAt: string | null;
}

interface UserAIProvider {
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  hasAnthropicKey: boolean;
  anthropicKeyPreview: string | null;
  hasLocalKey: boolean;
  hasOpenaiKey: boolean;
  openaiKeyPreview: string | null;
}

/**
 * Model presets per provider — keeps users out of the freetext box for
 * the common case and signals which models the resolver will actually
 * use as defaults if the field is left blank. The `__custom__` sentinel
 * surfaces a freetext Input so power users can still target any model
 * the underlying API speaks (e.g. preview models, fine-tunes).
 */
const MODEL_PRESETS: Record<string, ReadonlyArray<string>> = {
  // P15: dropped `gpt-5` (not a released model — would surface as
  // model_not_found) and `o3-mini` (uses the o-series param contract:
  // `max_completion_tokens` instead of `max_tokens`, no `temperature`
  // override — would 400 with the current OpenAIClient body shape).
  OPENAI: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
  ANTHROPIC: [
    "claude-sonnet-4-6",
    "claude-opus-4-7",
    "claude-haiku-4-5",
    "claude-3-5-sonnet-latest",
  ],
  LOCAL: ["llama3.1:8b", "llama3.1:70b", "mistral", "qwen2.5"],
};

const CUSTOM_MODEL_SENTINEL = "__custom__";

export function AiSection() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();

  return (
    <section aria-labelledby="settings-section-ai-title" className="space-y-6">
      <header className="space-y-1">
        <h1
          id="settings-section-ai-title"
          className="text-2xl font-semibold tracking-tight"
        >
          {t("settings.sections.ai.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.ai.description")}
        </p>
      </header>

      <InsightsSettingsCard isAuthenticated={isAuthenticated} />
    </section>
  );
}

function InsightsSettingsCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [disconnecting, setDisconnecting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  const { data: settings } = useQuery({
    queryKey: ["insights", "settings"],
    queryFn: async () => {
      const res = await fetch("/api/insights/settings");
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as InsightsSettings;
    },
    enabled: isAuthenticated,
  });

  const updateSettings = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await fetch("/api/insights/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["insights"] });
    },
  });

  // OAuth callback handler — reads `?codex_connected=true|codex_error=...`
  // from the URL and surfaces a toast-equivalent inline message. We do the
  // read at render time (via a `useState` lazy initialiser) so the strict
  // `react-hooks/set-state-in-effect` rule isn't triggered. The effect then
  // drains the result by clearing the URL params and invalidating queries.
  const [oauthOutcome] = useState<
    { kind: "connected" } | { kind: "error" } | null
  >(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    if (params.get("codex_connected") === "true") return { kind: "connected" };
    if (params.get("codex_error")) return { kind: "error" };
    return null;
  });

  useEffect(() => {
    if (!oauthOutcome) return;
    // The browser-history rewrite is the side effect; the matching i18n
    // message is already painted via the lazy initialiser below.
    window.history.replaceState({}, "", window.location.pathname);
    if (oauthOutcome.kind === "connected") {
      queryClient.invalidateQueries({ queryKey: ["insights"] });
    }
  }, [oauthOutcome, queryClient]);

  // Seed the initial inline message from the OAuth outcome. Reads happen
  // during render (allowed) — `setMsg` is only called by user actions after
  // mount, never inside an effect.
  const [oauthMsgSeeded, setOauthMsgSeeded] = useState(false);
  if (!oauthMsgSeeded && oauthOutcome) {
    setOauthMsgSeeded(true);
    if (oauthOutcome.kind === "connected") {
      setMsg(t("settings.codexConnected"));
      setMsgType("success");
    } else {
      setMsg(t("settings.codexConnectionFailed"));
      setMsgType("error");
    }
  }

  const hasProvider =
    settings?.codexStatus === "connected" || settings?.hasAdminKey;

  // v1.4.7.1: device-code flow. The earlier "redirect to
  // auth.openai.com" path fails because the public Codex CLI client
  // ID's redirect-URI allow-list only covers localhost. The device
  // flow side-steps that — the user types a short code on chatgpt.com
  // and we poll for confirmation.
  const [deviceCode, setDeviceCode] = useState<{
    userCode: string;
    verificationUrl: string;
    intervalSeconds: number;
  } | null>(null);
  const [devicePolling, setDevicePolling] = useState(false);

  async function handleConnect() {
    setMsg(null);
    setDevicePolling(true);
    try {
      const res = await fetch("/api/auth/codex/device-start", {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("settings.savingError"));
      setDeviceCode({
        userCode: json.data.userCode,
        verificationUrl: json.data.verificationUrl,
        intervalSeconds: json.data.intervalSeconds,
      });
    } catch (err) {
      setMsg(err instanceof Error ? err.message : t("settings.savingError"));
      setMsgType("error");
      setDevicePolling(false);
    }
  }

  // Poll until the user finishes the approval at chatgpt.com or the
  // 15-minute device-code window expires. Polling stops as soon as
  // `deviceCode` is cleared (success / cancel / unmount).
  useEffect(() => {
    if (!deviceCode) {
      // No active device code → make sure the spinner is off. setState
      // inside an effect is intentional here; the alternative (deriving
      // `devicePolling` from `deviceCode`) would force every error
      // path to also reset `deviceCode`, which we don't want — the
      // start handler resets `devicePolling` itself when fetch fails.
      return;
    }
    let cancelled = false;
    const intervalMs = Math.max(deviceCode.intervalSeconds, 3) * 1000;

    async function tick() {
      try {
        const res = await fetch("/api/auth/codex/device-poll", {
          method: "POST",
        });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          throw new Error(json.error || t("settings.savingError"));
        }
        if (json.data?.status === "connected") {
          setDeviceCode(null);
          setDevicePolling(false);
          setMsg(t("settings.codexConnected"));
          setMsgType("success");
          queryClient.invalidateQueries({ queryKey: ["insights"] });
          return;
        }
        // Pending → schedule next tick.
        if (!cancelled) setTimeout(tick, intervalMs);
      } catch (err) {
        if (cancelled) return;
        setMsg(err instanceof Error ? err.message : t("settings.savingError"));
        setMsgType("error");
        setDeviceCode(null);
        setDevicePolling(false);
      }
    }

    const handle = setTimeout(tick, intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceCode]);

  function handleCancelDevice() {
    setDeviceCode(null);
    setDevicePolling(false);
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    setMsg(null);
    try {
      const res = await fetch("/api/auth/codex/disconnect", {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error);
      }
      setMsg(t("settings.codexDisconnected"));
      setMsgType("success");
      queryClient.invalidateQueries({ queryKey: ["insights"] });
    } catch (err) {
      setMsg(err instanceof Error ? err.message : t("settings.savingError"));
      setMsgType("error");
    } finally {
      setDisconnecting(false);
    }
  }

  async function togglePrivacyMode() {
    const newMode = settings?.privacyMode === "raw" ? "aggregated" : "raw";
    await updateSettings.mutateAsync({ privacyMode: newMode });
  }

  async function handleRegenerate() {
    setRegenerating(true);
    setMsg(null);
    setMsgType(null);
    try {
      const res = await fetch("/api/insights/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      const json = await res.json();
      if (!res.ok) {
        if (res.status === 429) {
          setMsg(t("settings.regenerateRateLimit"));
        } else {
          setMsg(json.error || t("settings.savingError"));
        }
        setMsgType("error");
        return;
      }
      setMsg(t("settings.regenerateSuccess"));
      setMsgType("success");
      queryClient.invalidateQueries({ queryKey: ["insights"] });
    } catch {
      setMsg(t("settings.savingError"));
      setMsgType("error");
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <div className="bg-card border-border rounded-xl border p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t("settings.kiInsights")}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {settings?.codexStatus === "connected" && (
            <Badge className="border-dracula-green/30 bg-dracula-green/15 text-dracula-green">
              {t("settings.ai.chatgptConnectedBadge")}
            </Badge>
          )}
          {settings?.codexStatus !== "connected" && settings?.hasAdminKey && (
            <Badge className="border-dracula-purple/30 bg-dracula-purple/15 text-dracula-purple">
              {t("settings.ai.adminAiActiveBadge")}
            </Badge>
          )}
          {settings?.codexStatus === "expired" && (
            <Badge className="border-dracula-orange/30 bg-dracula-orange/15 text-dracula-orange">
              {t("settings.ai.connectionExpiredBadge")}
            </Badge>
          )}
          {settings?.lastInsightAt && (
            <Badge variant="outline" className="text-xs">
              {t("settings.lastGeneratedAt")}:{" "}
              {formatDateTime(settings.lastInsightAt)}
            </Badge>
          )}
        </div>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.kiInsightsDescription")}
      </p>

      <div className="mt-4 space-y-4">
        <div className="bg-muted/50 rounded-lg p-4">
          {settings?.codexStatus === "connected" ? (
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">
                  {t("settings.ai.chatgptConnectedHeading")}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t("settings.ai.chatgptConnectedBody")}
                  {settings.codexConnectedAt && (
                    <>
                      {" "}
                      {t("settings.ai.connectedSince", {
                        when: formatDateTime(settings.codexConnectedAt),
                      })}
                    </>
                  )}
                </p>
              </div>
              {/* v1.4.3: aligned with the Withings/moodLog disconnect
                  buttons — outline + text-destructive so the same action
                  reads the same everywhere in Settings. */}
              <Button
                variant="outline"
                size="sm"
                className="text-destructive shrink-0"
                onClick={handleDisconnect}
                disabled={disconnecting}
              >
                {disconnecting ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="mr-1 h-4 w-4" />
                )}
                {t("settings.ai.disconnect")}
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium">
                  {t("settings.ai.connectChatgptHeading")}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t("settings.ai.connectChatgptBody")}
                </p>
              </div>
              {settings?.codexOauthConfigured ? (
                deviceCode ? (
                  <div className="border-dracula-purple bg-dracula-purple/5 space-y-3 rounded-lg border-l-4 p-4">
                    <p className="text-sm font-medium">
                      {t("settings.ai.deviceCodeHeading")}
                    </p>
                    <ol className="text-muted-foreground list-decimal space-y-2 pl-5 text-sm">
                      <li>
                        {t("settings.ai.deviceCodeStep1")}{" "}
                        <a
                          href={deviceCode.verificationUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-dracula-purple font-medium underline"
                        >
                          {deviceCode.verificationUrl}
                        </a>
                      </li>
                      <li>
                        {t("settings.ai.deviceCodeStep2")}
                        <div className="bg-card border-border mt-2 inline-flex items-center gap-2 rounded border px-3 py-2 font-mono text-lg tracking-widest">
                          {deviceCode.userCode}
                          <button
                            type="button"
                            onClick={() =>
                              navigator.clipboard?.writeText(
                                deviceCode.userCode,
                              )
                            }
                            className="text-muted-foreground hover:text-foreground text-xs underline"
                          >
                            {t("settings.ai.deviceCodeCopy")}
                          </button>
                        </div>
                      </li>
                      <li>{t("settings.ai.deviceCodeStep3")}</li>
                    </ol>
                    <div className="flex items-center gap-3 text-xs">
                      {devicePolling && (
                        <span className="text-muted-foreground inline-flex items-center gap-1">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          {t("settings.ai.deviceCodeWaiting")}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={handleCancelDevice}
                        className="text-muted-foreground hover:text-foreground underline"
                      >
                        {t("settings.ai.deviceCodeCancel")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    onClick={handleConnect}
                    disabled={devicePolling}
                    className="w-full sm:w-auto"
                  >
                    {devicePolling ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="mr-2 h-4 w-4" />
                    )}
                    {t("settings.ai.connectChatgptCta")}
                  </Button>
                )
              ) : (
                <p className="text-muted-foreground text-xs italic">
                  {t("settings.ai.oauthNotConfigured")}
                </p>
              )}
              {settings?.hasAdminKey && (
                <p className="text-muted-foreground text-xs">
                  {t("settings.ai.adminFallback")}
                </p>
              )}
            </div>
          )}
        </div>

        {msg && (
          <p
            role="alert"
            className={`text-sm ${msgType === "success" ? "text-dracula-green" : "text-destructive"}`}
          >
            {msg}
          </p>
        )}

        {hasProvider && (
          <div className="bg-muted/50 rounded-lg p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="pr-2">
                <p className="text-sm font-medium">{t("settings.rawData")}</p>
                <p className="text-muted-foreground text-xs">
                  {settings?.privacyMode === "raw"
                    ? t("settings.rawDataOnDescription")
                    : t("settings.rawDataOffDescription")}
                </p>
              </div>
              <div className="ml-2 shrink-0">
                <Switch
                  checked={settings?.privacyMode === "raw"}
                  onCheckedChange={togglePrivacyMode}
                />
              </div>
            </div>
            {settings?.privacyMode === "raw" && (
              <div className="bg-dracula-orange/15 text-dracula-orange mt-2 rounded-lg p-2 text-xs">
                {t("settings.rawDataWarning")}
              </div>
            )}
          </div>
        )}

        {hasProvider && (
          <Button
            variant="outline"
            onClick={handleRegenerate}
            disabled={regenerating}
            className="w-full sm:w-auto"
          >
            {regenerating ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            {t("settings.regenerateInsights")}
          </Button>
        )}

        <UserAIProviderSubsection />
      </div>
    </div>
  );
}

function UserAIProviderSubsection() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<string>("");
  const [modelChoice, setModelChoice] = useState<string>("");
  const [customModel, setCustomModel] = useState<string>("");
  const [baseUrl, setBaseUrl] = useState<string>("");
  const [anthropicKey, setAnthropicKey] = useState<string>("");
  const [localKey, setLocalKey] = useState<string>("");
  const [openaiKey, setOpenaiKey] = useState<string>("");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<boolean>(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [testOk, setTestOk] = useState<boolean>(false);
  const [testing, setTesting] = useState<boolean>(false);

  const { data, isLoading } = useQuery({
    queryKey: ["user", "ai-provider"],
    queryFn: async () => {
      const res = await fetch("/api/user/ai-provider");
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as UserAIProvider;
    },
  });

  // React-recommended sync-from-server pattern (no setState-in-effect).
  // The model dropdown reflects the saved value: an exact match against
  // the preset list selects that preset; anything else (or the empty
  // "use default" string) collapses to the custom-input mode so the
  // user keeps full control.
  const dataKey = data
    ? `${data.provider ?? ""}|${data.model ?? ""}|${data.baseUrl ?? ""}`
    : null;
  const [seededKey, setSeededKey] = useState<string | null>(null);
  if (dataKey && dataKey !== seededKey) {
    setSeededKey(dataKey);
    const nextProvider = data!.provider ?? "";
    setProvider(nextProvider);
    const presets = MODEL_PRESETS[nextProvider] ?? [];
    const savedModel = data!.model ?? "";
    if (savedModel && presets.includes(savedModel)) {
      setModelChoice(savedModel);
      setCustomModel("");
    } else if (savedModel) {
      setModelChoice(CUSTOM_MODEL_SENTINEL);
      setCustomModel(savedModel);
    } else {
      setModelChoice("");
      setCustomModel("");
    }
    setBaseUrl(data!.baseUrl ?? "");
  }

  const presets = MODEL_PRESETS[provider] ?? [];
  const effectiveModel =
    modelChoice === CUSTOM_MODEL_SENTINEL
      ? customModel.trim()
      : modelChoice.trim();

  // Reset model dropdown when provider changes — the preset list is
  // provider-specific. Don't wipe the custom model the user typed in
  // case they wanted to keep using it (rare but cheap).
  function handleProviderChange(next: string) {
    setProvider(next);
    setModelChoice("");
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        provider: provider || null,
        model: effectiveModel || null,
        baseUrl: baseUrl || null,
      };
      if (anthropicKey.trim()) body.anthropicKey = anthropicKey.trim();
      if (localKey.trim()) body.localKey = localKey.trim();
      if (openaiKey.trim()) body.openaiKey = openaiKey.trim();
      const res = await fetch("/api/user/ai-provider", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("settings.ai.saveFailed"));
    },
    onSuccess: () => {
      setSaveMsg(t("settings.ai.saved"));
      setSaveOk(true);
      setAnthropicKey("");
      setLocalKey("");
      setOpenaiKey("");
      queryClient.invalidateQueries({ queryKey: ["user", "ai-provider"] });
      queryClient.invalidateQueries({ queryKey: ["insights"] });
    },
    onError: (e) => {
      setSaveMsg(
        e instanceof Error ? e.message : t("settings.ai.errorGeneric"),
      );
      setSaveOk(false);
    },
  });

  // v1.5 phase-5 — "Remove saved key" closes the v1.4.6 deferred polish.
  // Sends an explicit `null` for whichever provider key is stored so the
  // PATCH route clears it (the route already handles the empty-string /
  // null case). Provider/model/baseUrl are left alone so the user can
  // keep their selection while just rotating the secret.
  const removeKeyMutation = useMutation({
    mutationFn: async (target: "openaiKey" | "anthropicKey" | "localKey") => {
      const res = await fetch("/api/user/ai-provider", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [target]: null }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("settings.ai.saveFailed"));
    },
    onSuccess: () => {
      setSaveMsg(t("settings.ai.keyRemoved"));
      setSaveOk(true);
      queryClient.invalidateQueries({ queryKey: ["user", "ai-provider"] });
      queryClient.invalidateQueries({ queryKey: ["insights"] });
    },
    onError: (e) => {
      setSaveMsg(
        e instanceof Error ? e.message : t("settings.ai.errorGeneric"),
      );
      setSaveOk(false);
    },
  });

  /**
   * Maps the currently selected provider to its stored-key flag and the
   * PATCH-body field name. Returns null when there is no saved key for
   * the active provider — the "Remove saved key" button hides itself.
   */
  const removableKey: "openaiKey" | "anthropicKey" | "localKey" | null = (() => {
    if (provider === "OPENAI" && data?.hasOpenaiKey) return "openaiKey";
    if (provider === "ANTHROPIC" && data?.hasAnthropicKey)
      return "anthropicKey";
    if (provider === "LOCAL" && data?.hasLocalKey) return "localKey";
    return null;
  })();

  async function runTest() {
    setTesting(true);
    setTestMsg(null);
    try {
      const overrideBody: Record<string, string> = {};
      if (provider) overrideBody.provider = provider;
      if (effectiveModel) overrideBody.model = effectiveModel;
      if (baseUrl.trim()) overrideBody.baseUrl = baseUrl.trim();
      if (anthropicKey.trim()) overrideBody.anthropicKey = anthropicKey.trim();
      if (localKey.trim()) overrideBody.localKey = localKey.trim();
      if (openaiKey.trim()) overrideBody.openaiKey = openaiKey.trim();
      const hasOverride = Object.keys(overrideBody).length > 0;
      const res = await fetch("/api/ai/test", {
        method: "POST",
        headers: hasOverride ? { "Content-Type": "application/json" } : {},
        body: hasOverride ? JSON.stringify(overrideBody) : undefined,
      });
      const json = await res.json();
      if (!res.ok) {
        setTestMsg(json.error || `HTTP ${res.status}`);
        setTestOk(false);
        return;
      }
      setTestMsg(
        `OK — ${json.data.providerType} (${json.data.model})${
          json.data.tokensUsed ? `, ${json.data.tokensUsed} tokens` : ""
        }`,
      );
      setTestOk(true);
    } catch (e) {
      setTestMsg(e instanceof Error ? e.message : t("settings.ai.testFailed"));
      setTestOk(false);
    } finally {
      setTesting(false);
    }
  }

  if (isLoading) return null;

  return (
    <div className="bg-muted/50 mt-2 rounded-lg p-4">
      <div className="mb-3">
        <p className="text-sm font-medium">
          {t("settings.ai.personalProviderHeading")}
        </p>
        <p className="text-muted-foreground text-xs">
          {t("settings.ai.personalProviderBody")}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="ai-provider-select">
            {t("settings.ai.providerLabel")}
          </Label>
          <select
            id="ai-provider-select"
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value)}
            className="bg-background border-input mt-1 h-9 w-full rounded-md border px-2 text-sm"
          >
            <option value="">{t("settings.ai.providerOptionDefault")}</option>
            <option value="OPENAI">
              {t("settings.ai.providerOptionOpenai")}
            </option>
            <option value="ANTHROPIC">
              {t("settings.ai.providerOptionAnthropic")}
            </option>
            <option value="LOCAL">
              {t("settings.ai.providerOptionLocal")}
            </option>
          </select>
        </div>

        <div>
          <Label htmlFor="ai-model-select">{t("settings.ai.modelLabel")}</Label>
          <select
            id="ai-model-select"
            value={modelChoice}
            onChange={(e) => setModelChoice(e.target.value)}
            disabled={!provider}
            className="bg-background border-input mt-1 h-9 w-full rounded-md border px-2 text-sm disabled:opacity-60"
          >
            <option value="">{t("settings.ai.modelOptionDefault")}</option>
            {presets.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            {provider && (
              <option value={CUSTOM_MODEL_SENTINEL}>
                {t("settings.ai.modelOptionCustom")}
              </option>
            )}
          </select>
        </div>

        {modelChoice === CUSTOM_MODEL_SENTINEL && provider && (
          <div className="sm:col-span-2">
            <Label htmlFor="ai-model-custom">
              {t("settings.ai.customModelLabel")}
            </Label>
            <Input
              id="ai-model-custom"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder={
                provider === "ANTHROPIC"
                  ? "claude-3-5-sonnet-latest"
                  : provider === "LOCAL"
                    ? "llama3:8b"
                    : "gpt-4o-mini"
              }
              className="mt-1"
            />
          </div>
        )}

        {provider === "OPENAI" && (
          <div className="sm:col-span-2">
            <Label htmlFor="ai-openai-key">
              {t("settings.ai.openaiKeyLabel")}
              {data?.hasOpenaiKey && (
                <span className="text-muted-foreground ml-2 text-xs">
                  {t("settings.ai.savedPreview", {
                    preview: data.openaiKeyPreview ?? "",
                  })}
                </span>
              )}
            </Label>
            <PasswordInput
              id="ai-openai-key"
              value={openaiKey}
              onChange={(e) => setOpenaiKey(e.target.value)}
              placeholder="sk-..."
              className="mt-1"
            />
            <p className="text-muted-foreground mt-1 text-xs">
              {t("settings.ai.openaiKeyHelp")}
            </p>
          </div>
        )}

        {provider === "ANTHROPIC" && (
          <div className="sm:col-span-2">
            <Label htmlFor="ai-anthropic-key">
              {t("settings.ai.anthropicKeyLabel")}
              {data?.hasAnthropicKey && (
                <span className="text-muted-foreground ml-2 text-xs">
                  {t("settings.ai.savedPreview", {
                    preview: data.anthropicKeyPreview ?? "",
                  })}
                </span>
              )}
            </Label>
            <PasswordInput
              id="ai-anthropic-key"
              value={anthropicKey}
              onChange={(e) => setAnthropicKey(e.target.value)}
              placeholder="sk-ant-..."
              className="mt-1"
            />
          </div>
        )}

        {provider === "LOCAL" && (
          <>
            <div className="sm:col-span-2">
              <Label htmlFor="ai-base-url">
                {t("settings.ai.baseUrlLabel")}
              </Label>
              <Input
                id="ai-base-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://localhost:11434/v1"
                className="mt-1"
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="ai-local-key">
                {t("settings.ai.localKeyLabel")}
              </Label>
              <PasswordInput
                id="ai-local-key"
                value={localKey}
                onChange={(e) => setLocalKey(e.target.value)}
                placeholder={
                  data?.hasLocalKey ? t("settings.ai.savedShort") : ""
                }
                className="mt-1"
              />
            </div>
          </>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          {t("settings.ai.saveCta")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={runTest}
          disabled={testing}
        >
          {testing ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="mr-2 h-4 w-4" />
          )}
          {t("settings.ai.testCta")}
        </Button>
        {removableKey && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive"
                disabled={removeKeyMutation.isPending}
              >
                {removeKeyMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="mr-2 h-4 w-4" />
                )}
                {t("settings.ai.removeKeyCta")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("settings.ai.removeKeyConfirmTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("settings.ai.removeKeyConfirmBody")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => removeKeyMutation.mutate(removableKey)}
                >
                  {t("settings.ai.removeKeyCta")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      {saveMsg && (
        <p
          className={`mt-2 text-xs ${
            saveOk ? "text-dracula-green" : "text-destructive"
          }`}
        >
          {saveMsg}
        </p>
      )}
      {testMsg && (
        <p
          className={`mt-2 text-xs ${
            testOk ? "text-dracula-green" : "text-destructive"
          }`}
        >
          {testMsg}
        </p>
      )}
    </div>
  );
}
