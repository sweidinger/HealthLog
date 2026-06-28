"use client";

import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";

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
import { SettingsCard } from "@/components/settings/settings-card";
import { useTranslations } from "@/lib/i18n/context";
import { apiFetchRaw } from "@/lib/api/api-fetch";

/**
 * v1.4.43 QoL (M3) — separate destructive action for the full account
 * delete. Pre-fix, the only "danger zone" CTA wiped the user's health
 * data but left the user row, passkeys, audit log, and sessions
 * intact — half of what a user reading "Danger Zone" expects per
 * GDPR Article 17. The route `DELETE /api/settings/account` already
 * cascades User + passkeys + audit log + sessions (and is rate-limited
 * by the API handler); this card is its UI front door.
 *
 * Visually the card mirrors the data-reset shaping (neutral title,
 * red CTA only) but the dialog copy is explicit: this deletes the
 * account, not just the data, and the user will be signed out
 * immediately.
 *
 * v1.25.1 (Q2-M3) — moved out of Settings → Advanced (Data & Privacy group)
 * into the Account group. Deleting your account is an account-lifecycle
 * action, not a data/privacy control, so it belongs where a user looks for
 * "my account": next to the profile + sign-in surfaces. Research mode + the
 * data reset stay in Advanced.
 */
export function AccountDeleteCard() {
  const { t } = useTranslations();
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  async function handleDeleteAccount() {
    if (deleting) return;
    setDeleting(true);
    setMsg(null);
    setMsgType(null);
    try {
      const res = await apiFetchRaw("/api/settings/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE_ACCOUNT" }),
      });
      if (!res.ok) {
        try {
          const json = await res.json();
          setMsg(json.error || t("settings.deleteAccountFailed"));
        } catch {
          setMsg(t("settings.deleteAccountFailed"));
        }
        setMsgType("error");
        setDeleting(false);
        return;
      }
      setMsg(t("settings.deleteAccountSuccess"));
      setMsgType("success");
      // The route destroyed every session before deleting the row;
      // give the toast a beat to paint, then bounce to the login page.
      // Leave `deleting` set so the confirm button keeps its pending
      // state through the redirect — the row is gone, nothing to undo.
      setTimeout(() => {
        window.location.href = "/auth/login";
      }, 1_500);
    } catch {
      setMsg(t("settings.deleteAccountFailed"));
      setMsgType("error");
      setDeleting(false);
    }
  }

  return (
    <SettingsCard data-slot="settings-account-delete-card">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-2">
        <div className="space-y-1">
          <h2 className="text-foreground text-lg font-semibold">
            {t("settings.deleteAccountCardTitle")}
          </h2>
          <p className="text-muted-foreground text-xs">
            {t("settings.deleteAccountCardDescription")}
          </p>
        </div>
        <AlertDialog
          open={confirmOpen}
          onOpenChange={(open) => {
            // Hold the dialog open while the irreversible delete runs so
            // the pending state stays on screen and a stray dismissal
            // can't fire a second request.
            if (deleting) return;
            setConfirmOpen(open);
          }}
        >
          <AlertDialogTrigger asChild>
            <Button
              variant="destructive"
              size="sm"
              disabled={deleting}
              className="min-h-11 w-full shrink-0 sm:min-h-9 sm:w-auto"
              data-slot="settings-account-delete-trigger"
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              {t("settings.deleteAccountCta")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("settings.deleteAccountConfirmTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("settings.deleteAccountConfirmDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>
                {t("common.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={(e) => {
                  e.preventDefault();
                  void handleDeleteAccount();
                }}
                disabled={deleting}
                aria-busy={deleting || undefined}
                data-slot="settings-account-delete-confirm"
              >
                {deleting && (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                )}
                {t("settings.deleteAccountFinal")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {msg && (
        <p
          role="alert"
          className={`mt-3 text-sm ${msgType === "success" ? "text-success" : "text-destructive"}`}
        >
          {msg}
        </p>
      )}
    </SettingsCard>
  );
}
