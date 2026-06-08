"use client";

/**
 * v1.15.18 — medication detail page as the full-page tabbed shell.
 *
 * Supersedes the v1.7.2 history-centric composition. The page now owns
 * auth + the medication read and hands the snapshot to
 * `<MedicationDetailTabs>`, which carries the tab strip (Übersicht ·
 * Zeitplan · Erinnerung · Bestand · Verlauf · Injektion* · Erweitert),
 * `?tab=` URL state, the read-only hero and the "Vollständig bearbeiten"
 * jump into the wizard. The former modal advanced-settings sheet and the
 * separate `/history` route both fold into tabs here.
 */

import { use, useEffect } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  MedicationDetailTabs,
  type MedicationDetailSnapshot,
} from "@/components/medications/detail/MedicationDetailTabs";

export default function MedicationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const { t } = useTranslations();

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push("/auth/login");
    }
  }, [authLoading, isAuthenticated, router]);

  const {
    data: medication,
    isLoading,
    isError,
  } = useQuery<MedicationDetailSnapshot>({
    queryKey: queryKeys.medicationDetail(id),
    queryFn: async () => {
      const res = await fetch(`/api/medications/${id}`);
      if (!res.ok) throw new Error("medication_detail_failed");
      return (await res.json()).data as MedicationDetailSnapshot;
    },
    enabled: isAuthenticated,
    // A deleted medication 404s here. Don't burn a retry/backoff cycle on
    // a resource that no longer exists — the delete handler evicts this
    // key on success, but `retry: false` hardens any caller that
    // prefix-invalidates `["medications"]` while this page is mounted.
    retry: false,
  });

  if (authLoading || isLoading) {
    return (
      <div
        className="flex h-64 items-center justify-center"
        role="status"
        aria-busy="true"
        aria-live="polite"
      >
        <Loader2
          aria-hidden="true"
          className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none"
        />
      </div>
    );
  }

  if (isError || !medication) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" size="sm" className="-ml-2 w-fit" asChild>
          <Link href="/medications">
            <ArrowLeft className="mr-1 size-4" aria-hidden="true" />
            {t("medications.back")}
          </Link>
        </Button>
        <Card
          className="p-6"
          role="alert"
          aria-live="polite"
          data-slot="medication-detail-error-card"
        >
          <p className="text-destructive text-sm">
            {t("medications.detail.shell.loadFailed")}
          </p>
        </Card>
      </div>
    );
  }

  return <MedicationDetailTabs medication={medication} />;
}
