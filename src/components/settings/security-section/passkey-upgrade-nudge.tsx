"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiPost } from "@/lib/api/api-fetch";

/**
 * One-time, dismissible "add a passkey" prompt. Shown only when the account
 * has no passkey registered and has not dismissed the nudge before. Dismissal
 * is persisted on the user (`passkeyUpgradeNudgeDismissed`).
 */
export function PasskeyUpgradeNudge() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const dismiss = useMutation({
    mutationFn: async () => {
      await apiPost("/api/auth/me/passkey-nudge/dismiss");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mfaStatus() });
    },
  });

  return (
    <div className="border-primary/30 bg-primary/5 flex items-start gap-3 rounded-lg border p-4">
      <Sparkles className="text-primary mt-0.5 h-5 w-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {t("settings.security.passkeyNudge.title")}
        </p>
        <p className="text-muted-foreground mt-1 text-xs">
          {t("settings.security.passkeyNudge.body")}
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        onClick={() => dismiss.mutate()}
        disabled={dismiss.isPending}
        aria-label={t("common.dismiss")}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
