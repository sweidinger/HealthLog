"use client";

/* ────────────────────────────────────────────────────────────────
 * Standing AI consent — the web side of the withdrawal.
 *
 * The revoke endpoint (`DELETE /api/consent/ai/latest?kind=ai_full`) has
 * existed since v1.4.40, but only the native client ever called it: on the
 * web, consent could be given and never taken back. GDPR Art. 7 (3) puts
 * withdrawal on the same footing as the grant, so it belongs on the same
 * surface, not behind a support request.
 *
 * The card shows the standing decision in plain words and offers the one
 * move that changes it. Withdrawing takes effect immediately — the consent
 * gate fails closed without an active receipt, so every AI surface falls
 * back to its no-consent state on the next call. Nothing already stored is
 * deleted by this; that is the export/erase path in Data & Privacy, and the
 * copy says so rather than implying more than it does.
 * ──────────────────────────────────────────────────────────────── */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, ShieldCheck, ShieldOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

type ConsentReceiptWire = {
  id: string;
  kind: string;
  signedAt: string;
  revokedAt: string | null;
} | null;

export function AiConsentCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.aiConsentReceipt("ai_full"),
    queryFn: async () => {
      const res = await apiFetchRaw("/api/consent/ai/latest?kind=ai_full");
      if (!res.ok) return null;
      const json = await res.json();
      return (json.data?.receipt ?? null) as ConsentReceiptWire;
    },
    enabled: isAuthenticated,
  });

  const revoke = useMutation({
    mutationKey: queryKeys.aiConsentReceipt("ai_full"),
    mutationFn: async () => {
      const res = await apiFetchRaw("/api/consent/ai/latest?kind=ai_full", {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("revoke failed");
    },
    onSuccess: async () => {
      setConfirming(false);
      // The receipt gates every AI surface, so anything that reads consent
      // state has to re-resolve — not just this card.
      await queryClient.invalidateQueries({
        queryKey: queryKeys.aiConsentReceipt("ai_full"),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.insightsProviderChain(),
      });
    },
  });

  // Say nothing until the state is known: a card that flashes "withdrawn"
  // before the receipt arrives would misreport the user's own decision.
  if (!isAuthenticated || isLoading) return null;

  // Narrow to the receipt itself rather than a boolean, so the branches
  // below can read its fields without an assertion.
  const activeReceipt = data && data.revokedAt === null ? data : null;

  return (
    <section className="space-y-3" data-slot="ai-consent">
      <div className="space-y-1">
        <p className="flex items-center gap-2 text-sm font-medium">
          {activeReceipt ? (
            <ShieldCheck className="size-4" aria-hidden />
          ) : (
            <ShieldOff className="text-muted-foreground size-4" aria-hidden />
          )}
          {t("settings.ai.consent.title")}
        </p>
        <p className="text-muted-foreground text-xs">
          {activeReceipt
            ? t("settings.ai.consent.activeSince", {
                date: formatDateTime(activeReceipt.signedAt),
              })
            : t("settings.ai.consent.withdrawn")}
        </p>
      </div>

      {activeReceipt ? (
        confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-muted-foreground w-full text-xs">
              {t("settings.ai.consent.confirmBody")}
            </p>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              data-slot="ai-consent-withdraw-confirm"
              onClick={() => revoke.mutate()}
              disabled={revoke.isPending}
            >
              {revoke.isPending ? (
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
              ) : null}
              {t("settings.ai.consent.confirmWithdraw")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfirming(false)}
              disabled={revoke.isPending}
            >
              {t("common.cancel")}
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-slot="ai-consent-withdraw"
            onClick={() => setConfirming(true)}
          >
            {t("settings.ai.consent.withdraw")}
          </Button>
        )
      ) : (
        <p className="text-muted-foreground text-xs">
          {t("settings.ai.consent.regrantHint")}
        </p>
      )}

      {revoke.isError ? (
        <p className="text-destructive text-xs" role="alert">
          {t("settings.ai.consent.error")}
        </p>
      ) : null}
    </section>
  );
}
