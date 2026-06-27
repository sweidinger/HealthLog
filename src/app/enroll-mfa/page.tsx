"use client";

import { ShieldAlert, LogOut, Loader2 } from "lucide-react";

import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/button";
import { SecuritySection } from "@/components/settings/security-section";
import { useLogout } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.23 — forced second-factor enrollment interstitial.
 *
 * The proxy redirects here whenever the operator requires MFA and the account
 * has no active second factor (the `hl_mfa_enroll=required` hint cookie). It
 * reuses the security hub's enrollment cards (TOTP + security keys); the moment
 * a factor is confirmed the enrollment route clears the hint cookie and the
 * next navigation lands wherever the user was headed. A sign-out button keeps
 * the only other escape — the user is never trapped, and the operator's CLI
 * (`scripts/disable-mfa.ts`) / instance toggle is the recovery of last resort.
 */
export default function EnrollMfaPage() {
  const { t } = useTranslations();
  const logout = useLogout();

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-10">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="bg-primary/10 flex h-12 w-12 items-center justify-center rounded-lg">
          <Logo className="text-primary" size={28} />
        </div>
        <div className="space-y-2">
          <div className="text-foreground inline-flex items-center gap-2 text-lg font-semibold">
            <ShieldAlert className="text-primary h-5 w-5" aria-hidden="true" />
            {t("auth.enrollMfa.title")}
          </div>
          <p className="text-muted-foreground text-sm">
            {t("auth.enrollMfa.body")}
          </p>
        </div>
      </div>

      <SecuritySection />

      <div className="flex justify-center">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
        >
          {logout.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <LogOut className="h-4 w-4" />
          )}
          {t("auth.enrollMfa.signOut")}
        </Button>
      </div>
    </div>
  );
}
