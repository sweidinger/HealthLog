"use client";

/**
 * v1.5.5 D-3 §9.7 — Settings → Externe Integration sub-row.
 *
 * Wraps the v1.5.4 `ApiEndpointDialog` body into a settings-row shape.
 * The row mounts unconditionally so every medication can be reached
 * over the external API. Caption above the URL reads
 * `Endpunkt für „{name}"`; two buttons sit below — `[URL kopieren]`
 * and `[Token erzeugen]`. When the user mints a token the value
 * surfaces in a one-shot modal that auto-closes after copy (D-3 §7
 * Feature 6).
 *
 * Cache: invalidates `tokens()` + `medicationDependentKeys` on every
 * mint / disable so the Tokens settings page reflects the new state
 * without a manual refresh.
 */

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import {
  invalidateKeys,
  medicationDependentKeys,
  queryKeys,
} from "@/lib/query-keys";

export interface ApiTokensRowProps {
  medicationId: string;
  medicationName: string;
}

interface ApiEndpointStatus {
  enabled: boolean;
  activeTokenCount: number;
}

export function ApiTokensRow({
  medicationId,
  medicationName,
}: ApiTokensRowProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [mintedToken, setMintedToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // v1.5.5 F-1 H-2 — single source of truth for the per-medication
  // api-endpoint key. The earlier inline `useMemo` minted the same
  // tuple as a bare array, slipping past `healthlog/queryKey-factory`.
  // Reading from the factory keeps the bundle invalidation +
  // `setQueryData` shape stable across consumers.
  const queryKey = queryKeys.medicationApiEndpoint(medicationId);

  const { data: status } = useQuery<ApiEndpointStatus>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(`/api/medications/${medicationId}/api-endpoint`);
      if (!res.ok) throw new Error("status_failed");
      const json = await res.json();
      return {
        enabled: json.data.enabled === true,
        activeTokenCount: json.data.activeTokenCount ?? 0,
      };
    },
    staleTime: 0,
  });

  const enabled = status?.enabled ?? false;
  const baseUrl =
    typeof window !== "undefined" ? window.location.origin : "https://...";
  const endpoint = `${baseUrl}/api/ingest/medication`;

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(label);
    } catch {
      toast.error(t("medications.detail.api.copyFailed"));
    }
  }

  async function mintToken() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/medications/${medicationId}/api-endpoint`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? t("medications.detail.api.mintFailed"));
        return;
      }
      if (json.data.token) {
        setMintedToken(json.data.token);
        // Auto-copy on mint so the user has it without an extra tap.
        try {
          await navigator.clipboard.writeText(json.data.token);
        } catch {
          // Clipboard rejection is silent — the value is still visible
          // in the read-only one-shot panel below.
        }
      }
      await invalidateKeys(queryClient, [
        ...medicationDependentKeys,
        queryKeys.tokens(),
      ]);
      queryClient.setQueryData<ApiEndpointStatus>(queryKey, {
        enabled: json.data.enabled === true,
        activeTokenCount:
          typeof json.data.activeTokenCount === "number"
            ? json.data.activeTokenCount
            : (status?.activeTokenCount ?? 0) + 1,
      });
    } catch {
      toast.error(t("medications.detail.api.mintFailed"));
    } finally {
      setBusy(false);
    }
  }

  // Auto-clear the minted token after 30 s so the value never lingers
  // in the DOM longer than needed.
  useEffect(() => {
    if (!mintedToken) return;
    const id = setTimeout(() => setMintedToken(null), 30_000);
    return () => clearTimeout(id);
  }, [mintedToken]);

  return (
    <div
      className="space-y-2"
      data-slot="medication-detail-api-tokens-row"
    >
      <p className="text-muted-foreground text-xs">
        {t("medications.detail.api.caption", { name: medicationName })}
      </p>
      <code
        className="bg-muted block rounded px-3 py-2 font-mono text-xs break-all"
        data-slot="api-endpoint-url"
      >
        POST {endpoint}
      </code>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void copy(endpoint, t("medications.detail.api.urlCopied"))}
          className="min-h-11 sm:min-h-9"
          data-slot="api-tokens-copy-url"
        >
          <Copy aria-hidden="true" className="h-4 w-4" />
          {t("medications.detail.api.copyUrl")}
        </Button>
        <Button
          size="sm"
          onClick={() => void mintToken()}
          disabled={busy}
          aria-busy={busy || undefined}
          className="min-h-11 sm:min-h-9"
          data-slot="api-tokens-mint"
        >
          <KeyRound aria-hidden="true" className="h-4 w-4" />
          {enabled
            ? t("medications.detail.api.mintAnotherToken")
            : t("medications.detail.api.mintToken")}
        </Button>
      </div>

      {mintedToken && (
        <div
          className="border-border bg-muted/50 mt-2 space-y-1.5 rounded-md border p-3"
          role="status"
          aria-live="polite"
          data-slot="api-tokens-minted"
        >
          <p className="text-foreground text-xs font-medium">
            {t("medications.detail.api.mintedHint")}
          </p>
          <code className="bg-background block rounded px-2 py-1.5 font-mono text-xs break-all">
            {mintedToken}
          </code>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void copy(mintedToken, t("medications.detail.api.tokenCopied"))
            }
            className="h-auto px-1 py-1 text-xs"
          >
            <Copy aria-hidden="true" className="h-3.5 w-3.5" />
            {t("medications.detail.api.copyToken")}
          </Button>
        </div>
      )}
    </div>
  );
}
