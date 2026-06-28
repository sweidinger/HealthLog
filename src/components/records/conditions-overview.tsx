"use client";

/**
 * v1.25.1 — pre-existing / chronic conditions, surfaced in the Anamnese
 * (medical-history) home.
 *
 * The chronic-conditions note and the explicit "what should the Coach watch"
 * focus the user entered in Settings → Profile → "About me" are foundational
 * medical history, so they are surfaced here next to allergies + family history
 * to give one coherent medical-history overview.
 *
 * This is a READ-ONLY shared view of the existing self-context
 * (`GET /api/coach/about-me`) — it reads through the same query-key the "About
 * me" panel writes, so the two stay in lockstep. Editing keeps its single home
 * in personal context (linked below); nothing is moved, no new storage, no
 * schema change. Plain text only — values render as React text children, no
 * markdown renderer (XSS posture, see contributor notes).
 */
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";

interface SelfContext {
  conditions: string | null;
  coachFocus: string | null;
}

export function ConditionsOverview() {
  const { t } = useTranslations();
  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.coachAboutMe(),
    queryFn: () => apiGet<SelfContext>("/api/coach/about-me"),
  });

  const conditions = (data?.conditions ?? "").trim();
  const coachFocus = (data?.coachFocus ?? "").trim();
  const hasAny = conditions.length > 0 || coachFocus.length > 0;

  return (
    <div className="space-y-4" data-slot="conditions-overview">
      {isLoading && (
        <Loader2 className="text-muted-foreground h-5 w-5 animate-spin motion-reduce:animate-none" />
      )}

      {isError && (
        <p role="alert" className="text-destructive text-sm">
          {t("records.conditions.loadError")}
        </p>
      )}

      {!isLoading && !isError && (
        <>
          {hasAny ? (
            <dl className="space-y-3">
              {conditions.length > 0 && (
                <div className="space-y-1">
                  <dt className="text-sm font-medium">
                    {t("records.conditions.conditionsLabel")}
                  </dt>
                  <dd className="text-muted-foreground text-sm whitespace-pre-wrap">
                    {conditions}
                  </dd>
                </div>
              )}
              {coachFocus.length > 0 && (
                <div className="space-y-1">
                  <dt className="text-sm font-medium">
                    {t("records.conditions.focusLabel")}
                  </dt>
                  <dd className="text-muted-foreground text-sm whitespace-pre-wrap">
                    {coachFocus}
                  </dd>
                </div>
              )}
            </dl>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t("records.conditions.empty")}
            </p>
          )}

          <p className="text-xs">
            <Link
              href="/settings/account"
              className="text-dracula-purple underline-offset-4 hover:underline"
            >
              {t("records.conditions.editCta")}
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
