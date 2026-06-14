"use client";

import Link from "next/link";
import { CheckCircle2, FileUp, PlusCircle, Plug } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.4.25 W14b-Content — onboarding step 4 (done).
 *
 * Confirms the user has finished onboarding. `onboardingCompletedAt`
 * was flipped server-side by the baseline form's `POST step:4` write,
 * so this page is purely presentational — no further mutation, no
 * cookie flips, no API calls.
 *
 * The single CTA returns the user to the dashboard. The link goes
 * through `next/link` so the regular client-side navigation kicks in
 * (the proxy redirect was cleared with the same step-API write that
 * landed the user here).
 */

export function DoneScreen() {
  const { t } = useTranslations();

  return (
    <section
      aria-labelledby="onboarding-done-title"
      className="flex flex-col items-center gap-6 py-6 text-center"
    >
      <span
        aria-hidden="true"
        className="bg-primary/10 text-primary flex size-20 items-center justify-center rounded-full"
      >
        <CheckCircle2 className="size-10" />
      </span>

      <header className="space-y-2">
        <h1
          id="onboarding-done-title"
          tabIndex={-1}
          className="text-2xl font-semibold tracking-tight"
        >
          {t("onboarding.done.title")}
        </h1>
        <p className="text-muted-foreground mx-auto max-w-md text-base leading-relaxed">
          {t("onboarding.done.body")}
        </p>
        <p className="text-muted-foreground mx-auto max-w-md text-sm leading-relaxed">
          {t("onboarding.done.learning")}
        </p>
      </header>

      <div className="flex w-full max-w-xs flex-col gap-2">
        <Button asChild size="lg">
          <Link
            href="/settings/integrations"
            className="inline-flex items-center gap-2"
          >
            <Plug className="size-4" />
            {t("onboarding.done.connectCta")}
          </Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link
            href="/measurements"
            className="inline-flex items-center gap-2"
          >
            <PlusCircle className="size-4" />
            {t("onboarding.done.logCta")}
          </Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/">{t("onboarding.done.returnCta")}</Link>
        </Button>
      </div>

      <Link
        href="/settings/export"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm underline-offset-4 hover:underline"
      >
        <FileUp className="size-3.5" />
        {t("onboarding.done.importCta")}
      </Link>
    </section>
  );
}
