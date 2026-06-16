"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
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
import { useTranslations } from "@/lib/i18n/context";
import { apiDelete } from "@/lib/api/api-fetch";

export function DangerZoneSection() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [wipeMsg, setWipeMsg] = useState<string | null>(null);

  const wipeAllData = useMutation({
    mutationFn: async () => {
      return apiDelete<{
        measurements: number;
        intakeEvents: number;
        medications: number;
        apiTokens: number;
        withingsConnections: number;
        authChallenges: number;
        notificationChannels: number;
        pushSubscriptions: number;
        telegramScheduledDeletions: number;
      }>("/api/admin/data", { confirm: "DELETE ALL" });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries();
      setWipeMsg(
        t("admin.deletedResult", {
          measurements: data.measurements,
          medications: data.medications,
          intakeEvents: data.intakeEvents,
          apiTokens: data.apiTokens,
          withingsConnections: data.withingsConnections,
          authChallenges: data.authChallenges,
          notificationChannels: data.notificationChannels,
          pushSubscriptions: data.pushSubscriptions,
          telegramScheduledDeletions: data.telegramScheduledDeletions,
        }),
      );
    },
    onError: (err: Error) => {
      setWipeMsg(err.message);
    },
  });

  return (
    // v1.18.1 E4 — adopt the shared card shape (rounded-xl border + the
    // `SettingsCardHeader` icon/title/description/status layout) so the
    // Danger Zone reads like every other admin section. The destructive
    // tint + AlertTriangle icon keep it visually flagged as dangerous;
    // the delete affordance now sits in the header status slot, properly
    // aligned beside its label rather than floating below a lone icon.
    <div className="bg-destructive/5 border-destructive/30 rounded-xl border p-4 sm:p-6">
      <SettingsCardHeader
        icon={AlertTriangle}
        title={t("admin.deleteAllData")}
        description={t("admin.deleteAllDescription")}
        status={
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                size="sm"
                disabled={wipeAllData.isPending}
                className="min-h-11"
              >
                {wipeAllData.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                {t("admin.deleteButton")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("admin.deleteAllConfirm")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("admin.deleteAllConfirmDescription")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={wipeAllData.isPending}
                  aria-busy={wipeAllData.isPending || undefined}
                  onClick={() => wipeAllData.mutate()}
                >
                  {wipeAllData.isPending && (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                  )}
                  {t("admin.finalDelete")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        }
      />
      {wipeMsg && (
        <p
          className={`mt-3 pl-7 text-sm ${
            wipeAllData.isError ? "text-destructive" : "text-dracula-green"
          }`}
        >
          {wipeMsg}
        </p>
      )}
    </div>
  );
}
