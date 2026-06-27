"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Fingerprint,
  KeyRound,
  Loader2,
  Pencil,
  Trash2,
  X,
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
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { formatDate } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  ApiError,
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
} from "@/lib/api/api-fetch";
import { describePasskeyError } from "@/lib/passkey-errors";

interface PasskeyInfo {
  id: string;
  name: string;
  credentialDeviceType: string;
  credentialBackedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * Primary-passkey management: list (name, device, backup, created, last used),
 * add (registration ceremony), rename, and delete. The passwordless-primary
 * passkey home — distinct from the second-factor security keys above.
 */
export function PasskeyListSection({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const { data: passkeys } = useQuery({
    queryKey: queryKeys.passkeys(),
    queryFn: async () => apiGet<PasskeyInfo[]>("/api/auth/passkeys"),
    enabled: isAuthenticated,
  });

  const add = useMutation({
    mutationFn: async () => {
      const { startRegistration } = await import("@simplewebauthn/browser");
      const { options, challengeId } = await apiPost<{
        options: Parameters<typeof startRegistration>[0]["optionsJSON"];
        challengeId: string;
      }>("/api/auth/passkey/register-options");
      const credential = await startRegistration({ optionsJSON: options });
      await apiPost("/api/auth/passkey/register-verify", {
        challengeId,
        credential,
      });
    },
    onSuccess: () => {
      setMsg(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.passkeys() });
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setMsg(err.message || t("settings.passkeyRegistrationFailed"));
      } else {
        const { key, params } = describePasskeyError(err);
        setMsg(t(key, params));
      }
    },
  });

  const rename = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      await apiPatch(`/api/auth/passkeys/${id}`, { name });
    },
    onSuccess: () => {
      setEditingId(null);
      setMsg(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.passkeys() });
    },
    onError: (err: Error) => setMsg(err.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await apiDelete(`/api/auth/passkeys/${id}`);
    },
    onSuccess: () => {
      setMsg(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.passkeys() });
    },
    onError: (err: Error) => setMsg(err.message),
  });

  const DEVICE_TYPE_LABELS: Record<string, string> = {
    singleDevice: t("settings.singleDevice"),
    multiDevice: t("settings.multiDevice"),
  };

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={Fingerprint}
        title={t("settings.passkeys")}
        description={t("settings.passkeysDescription")}
      />

      <div className="mt-4">
        {!passkeys || passkeys.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("settings.noPasskeys")}
          </p>
        ) : (
          <ul className="space-y-2" data-testid="passkeys-list">
            {passkeys.map((pk) => (
              <SettingsCard as="li" key={pk.id}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    {editingId === pk.id ? (
                      <form
                        className="flex items-center gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          rename.mutate({ id: pk.id, name: editName.trim() });
                        }}
                      >
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          maxLength={64}
                          aria-label={t("settings.passkeyName")}
                          autoFocus
                        />
                        <Button
                          type="submit"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          disabled={
                            rename.isPending || editName.trim().length === 0
                          }
                          aria-label={t("common.save")}
                        >
                          {rename.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                          ) : (
                            <Check className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          onClick={() => setEditingId(null)}
                          aria-label={t("common.cancel")}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </form>
                    ) : (
                      <>
                        <p className="truncate text-sm font-medium">
                          {pk.name}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                          <Badge variant="outline" className="text-xs">
                            {DEVICE_TYPE_LABELS[pk.credentialDeviceType] ??
                              pk.credentialDeviceType}
                          </Badge>
                          <Badge
                            variant={
                              pk.credentialBackedUp ? "secondary" : "outline"
                            }
                            className="text-xs"
                          >
                            {pk.credentialBackedUp
                              ? t("settings.backedUp")
                              : t("common.no")}
                          </Badge>
                          <span className="text-muted-foreground">
                            {pk.lastUsedAt
                              ? t("settings.security.keys.lastUsed", {
                                  date: formatDate(pk.lastUsedAt),
                                })
                              : t("settings.security.keys.neverUsed")}
                          </span>
                        </div>
                      </>
                    )}
                  </div>

                  {editingId !== pk.id && (
                    <div className="flex shrink-0 gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="min-h-11 min-w-11 sm:h-8 sm:min-h-0 sm:w-8 sm:min-w-0"
                        onClick={() => {
                          setEditingId(pk.id);
                          setEditName(pk.name);
                        }}
                        aria-label={t("settings.security.keys.rename")}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="text-destructive min-h-11 min-w-11 sm:h-8 sm:min-h-0 sm:w-8 sm:min-w-0"
                            disabled={remove.isPending}
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
                            <AlertDialogCancel>
                              {t("common.cancel")}
                            </AlertDialogCancel>
                            <AlertDialogAction
                              variant="destructive"
                              disabled={remove.isPending}
                              aria-busy={remove.isPending || undefined}
                              onClick={() => remove.mutate(pk.id)}
                            >
                              {remove.isPending && (
                                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                              )}
                              {t("common.delete")}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  )}
                </div>
              </SettingsCard>
            ))}
          </ul>
        )}

        <div className="mt-4">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            onClick={() => add.mutate()}
            disabled={add.isPending}
          >
            {add.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <KeyRound className="h-4 w-4" />
            )}
            {t("settings.addPasskey")}
          </Button>
        </div>

        {msg && (
          <div
            role="alert"
            className="text-destructive mt-3 flex items-center gap-2 text-sm"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {msg}
          </div>
        )}
      </div>
    </SettingsCard>
  );
}
