"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiDelete, apiGet } from "@/lib/api/api-fetch";

interface PasskeyInfo {
  id: string;
  name: string;
  credentialDeviceType: string;
  credentialBackedUp: boolean;
  createdAt: string;
}

export function PasskeyListSection({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [deleteMsg, setDeleteMsg] = useState<string | null>(null);

  const { data: passkeys } = useQuery({
    queryKey: queryKeys.passkeys(),
    queryFn: async () => {
      return apiGet<PasskeyInfo[]>("/api/auth/passkeys");
    },
    enabled: isAuthenticated,
  });

  const deletePasskey = useMutation({
    mutationFn: async (id: string) => {
      await apiDelete(`/api/auth/passkeys/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.passkeys() });
      setDeleteMsg(null);
    },
    onError: (err: Error) => {
      setDeleteMsg(err.message);
    },
  });

  const DEVICE_TYPE_LABELS: Record<string, string> = {
    singleDevice: t("settings.singleDevice"),
    multiDevice: t("settings.multiDevice"),
  };

  if (!passkeys || passkeys.length === 0) {
    return (
      <div>
        <h3 className="text-sm font-semibold">{t("settings.passkeys")}</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          {t("settings.noPasskeys")}
        </p>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-sm font-semibold">
        {t("settings.registeredPasskeys")}
      </h3>
      <p className="text-muted-foreground mt-1 text-xs">
        {t("settings.passkeysDescription")}
      </p>
      {/* Phase A5 / B-mobile HIGH: the passkey table previously
          rendered with `min-w-[620px]` inside `overflow-x-auto`,
          which on a 393px viewport hid the right-most column —
          including the destructive delete action. Render the desktop
          table only at `≥ md`, and at `< md` paint a card-list where
          every passkey's name, device type, backup status, created
          date, and delete action are all visible without scrolling. */}
      {/* v1.4.33 — desktop table flips to card list at `lg` instead
          of `md` so iPad portrait (768 px = exactly the `md`
          inflection) lands on the card layout. The table needs
          ~620 px of column width to read; below that it scrolls
          horizontally and the destructive delete column is the one
          that disappears. */}
      <div className="border-border mt-3 hidden overflow-x-auto rounded-lg border lg:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/40 text-muted-foreground border-b text-xs">
              <th className="px-3 py-2 text-left font-medium">
                {t("settings.passkeyName")}
              </th>
              <th className="px-3 py-2 text-left font-medium">
                {t("settings.passkeyDevice")}
              </th>
              <th className="px-3 py-2 text-left font-medium">
                {t("settings.passkeyBackup")}
              </th>
              <th className="px-3 py-2 text-left font-medium">
                {t("settings.passkeyCreated")}
              </th>
              <th className="px-3 py-2 text-right font-medium">
                {t("settings.passkeyActions")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {passkeys.map((pk, idx) => (
              <tr key={pk.id} className={idx % 2 === 0 ? "bg-muted/20" : ""}>
                <td className="px-3 py-2 font-medium">{pk.name}</td>
                <td className="text-muted-foreground px-3 py-2 text-xs">
                  {DEVICE_TYPE_LABELS[pk.credentialDeviceType] ??
                    pk.credentialDeviceType}
                </td>
                <td className="px-3 py-2 text-xs">
                  <Badge
                    variant={pk.credentialBackedUp ? "secondary" : "outline"}
                    className="text-[11px]"
                  >
                    {pk.credentialBackedUp
                      ? t("settings.backedUp")
                      : t("common.no")}
                  </Badge>
                </td>
                <td className="text-muted-foreground px-3 py-2 text-xs whitespace-nowrap">
                  {formatDate(pk.createdAt)}
                </td>
                <td className="px-3 py-2 text-right">
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive h-8 w-8"
                        disabled={deletePasskey.isPending}
                        aria-label={t("settings.deletePasskey")}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {t("settings.deletePasskey")}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {t("settings.deletePasskeyDescription")}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>
                          {t("common.cancel")}
                        </AlertDialogCancel>
                        <AlertDialogAction
                          variant="destructive"
                          disabled={deletePasskey.isPending}
                          aria-busy={deletePasskey.isPending || undefined}
                          onClick={() => deletePasskey.mutate(pk.id)}
                        >
                          {deletePasskey.isPending && (
                            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                          )}
                          {t("common.delete")}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile + tablet card list — < lg only. Each passkey gets
          its own card so the delete action stays visible and
          tap-targetable (44 px) without the user having to
          horizontally scroll through a wide table. v1.4.33 bumped
          the breakpoint from `md` to `lg` so iPad portrait (768 px)
          stays on the card layout instead of flipping between
          layouts on rotation. */}
      <ul
        className="mt-3 space-y-2 lg:hidden"
        data-testid="passkeys-mobile-list"
      >
        {passkeys.map((pk) => (
          <li
            key={pk.id}
            className="bg-card border-border rounded-lg border p-4"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{pk.name}</p>
                {/* v1.4.27 MB7 / CF-75 — promote the device-type from
                    plain text to an outline Badge so the mobile card
                    list reads consistent with the desktop table's
                    "Single-device / Multi-device" column. Sits on the
                    same chip row as the backup status and date so all
                    metadata reads as a single horizontal stride. */}
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <Badge variant="outline" className="text-[11px]">
                    {DEVICE_TYPE_LABELS[pk.credentialDeviceType] ??
                      pk.credentialDeviceType}
                  </Badge>
                  <Badge
                    variant={pk.credentialBackedUp ? "secondary" : "outline"}
                    className="text-[11px]"
                  >
                    {pk.credentialBackedUp
                      ? t("settings.backedUp")
                      : t("common.no")}
                  </Badge>
                  <span className="text-muted-foreground">
                    {formatDate(pk.createdAt)}
                  </span>
                </div>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive min-h-11 min-w-11"
                    disabled={deletePasskey.isPending}
                    aria-label={t("settings.deletePasskey")}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.deletePasskey")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.deletePasskeyDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      disabled={deletePasskey.isPending}
                      aria-busy={deletePasskey.isPending || undefined}
                      onClick={() => deletePasskey.mutate(pk.id)}
                    >
                      {deletePasskey.isPending && (
                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                      )}
                      {t("common.delete")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </li>
        ))}
      </ul>
      {deleteMsg && (
        <div
          role="alert"
          className="text-destructive mt-2 flex items-center gap-2 text-sm"
        >
          <AlertTriangle className="h-4 w-4" />
          {deleteMsg}
        </div>
      )}
    </div>
  );
}
