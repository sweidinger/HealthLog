"use client";

/* ────────────────────────────────────────────────────────────────
 * v1.22 (#90) — Document scanning (Lab reports).
 *
 * Opt-in dedicated provider for the Lab-OCR ingestion path. OFF by default:
 * scanning uses the main provider chain. When enabled, document/lab-report
 * processing routes to THIS provider/model/key instead — so a user can keep a
 * cheap text Coach on one provider and send expensive vision OCR to a
 * vision-capable one. Surfaces a hint when the chosen model can't read images.
 * ──────────────────────────────────────────────────────────────── */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { PasswordInput } from "@/components/ui/password-input";
import { Switch } from "@/components/ui/switch";
import { apiPatch } from "@/lib/api/api-fetch";
import {
  supportsVisionForConfig,
  type VisionProviderType,
} from "@/lib/ai/vision-capability";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { OCR_PROVIDER_TYPES, type UserAIProvider } from "./shared";

/** Map the OCR provider enum to the vision-capability tag. */
function toVisionType(provider: string): VisionProviderType {
  switch (provider) {
    case "ANTHROPIC":
      return "anthropic";
    case "OPENAI":
      return "openai";
    case "LOCAL":
      return "local";
    default:
      return "none";
  }
}

export function DocumentScanCard({
  userProvider,
}: {
  userProvider: UserAIProvider | null | undefined;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<string>("OPENAI");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const seededKey =
    userProvider != null
      ? `${userProvider.ocrEnabled}|${userProvider.ocrProvider ?? ""}|${userProvider.ocrModel ?? ""}|${userProvider.ocrBaseUrl ?? ""}`
      : null;
  const [previousSeed, setPreviousSeed] = useState<string | null>(null);
  if (seededKey != null && seededKey !== previousSeed) {
    setPreviousSeed(seededKey);
    setEnabled(userProvider?.ocrEnabled ?? false);
    setProvider(userProvider?.ocrProvider ?? "OPENAI");
    setModel(userProvider?.ocrModel ?? "");
    setBaseUrl(userProvider?.ocrBaseUrl ?? "");
  }

  // Vision-capability hint: warn when a model is chosen that can't read images
  // (local is trust-by-default; the warning surfaces only for cloud providers).
  const visionOk =
    !enabled ||
    model.trim() === "" ||
    supportsVisionForConfig(toVisionType(provider), model.trim());

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        ocrEnabled: enabled,
        ocrProvider: provider,
        ocrModel: model.trim() || null,
        ocrBaseUrl: provider === "LOCAL" ? baseUrl.trim() || null : null,
      };
      if (apiKey.trim()) body.ocrKey = apiKey.trim();
      await apiPatch("/api/user/ai-provider", body);
    },
    onSuccess: () => {
      setOk(true);
      setMsg(t("settings.ai.saved"));
      setApiKey("");
      queryClient.invalidateQueries({ queryKey: queryKeys.userAiProvider() });
    },
    onError: (e) => {
      setOk(false);
      setMsg(e instanceof Error ? e.message : t("settings.ai.errorGeneric"));
    },
  });

  return (
    <div className="bg-muted/50 space-y-4 rounded-lg p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{t("settings.ai.ocrHeading")}</p>
          <p className="text-muted-foreground text-xs">
            {t("settings.ai.ocrBody")}
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={t("settings.ai.ocrEnableLabel")}
          data-testid="ai-ocr-enable"
        />
      </div>

      {enabled && (
        <div className="space-y-4">
          <div>
            <Label htmlFor="ai-ocr-provider">
              {t("settings.ai.ocrProviderLabel")}
            </Label>
            <NativeSelect
              id="ai-ocr-provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="mt-1 sm:max-w-md"
            >
              {OCR_PROVIDER_TYPES.map((p) => (
                <option key={p} value={p}>
                  {t(`settings.ai.ocrProviderOption.${p}` as const)}
                </option>
              ))}
            </NativeSelect>
          </div>

          <div>
            <Label htmlFor="ai-ocr-model">{t("settings.ai.modelLabel")}</Label>
            <Input
              id="ai-ocr-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={t("settings.ai.ocrModelPlaceholder")}
              className="mt-1"
            />
            {!visionOk && (
              <p className="text-warning mt-1 text-xs">
                {t("settings.ai.ocrVisionHint")}
              </p>
            )}
          </div>

          {provider === "LOCAL" && (
            <div>
              <Label htmlFor="ai-ocr-base-url">
                {t("settings.ai.baseUrlLabel")}
              </Label>
              <Input
                id="ai-ocr-base-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://localhost:11434/v1"
                className="mt-1"
              />
            </div>
          )}

          <div>
            <Label htmlFor="ai-ocr-key">{t("settings.ai.ocrKeyLabel")}</Label>
            <PasswordInput
              id="ai-ocr-key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                userProvider?.hasOcrKey ? t("settings.ai.savedShort") : ""
              }
              className="mt-1"
            />
          </div>
        </div>
      )}

      <div>
        <Button
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {t("settings.ai.saveCta")}
        </Button>
      </div>

      {msg && (
        <p className={`text-xs ${ok ? "text-success" : "text-destructive"}`}>
          {msg}
        </p>
      )}
    </div>
  );
}
