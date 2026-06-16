"use client";

/**
 * v1.18.1 — per-biomarker detail page (`/labs/[biomarkerId]`).
 *
 * Owns auth + the back link and hands the marker id to
 * `<LabBiomarkerDetail>`, which carries the heading, the dashboard-style
 * chart with the reference band, and the editable reading history.
 */
import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { LabBiomarkerDetail } from "@/components/labs/lab-biomarker-detail";
import { BackLink } from "@/components/ui/back-link";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";

export default function LabBiomarkerDetailPage({
  params,
}: {
  params: Promise<{ biomarkerId: string }>;
}) {
  const { biomarkerId } = use(params);
  const { isAuthenticated, isLoading } = useAuth();
  const mounted = useMounted();
  const router = useRouter();
  const { t } = useTranslations();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push("/auth/login");
    }
  }, [isLoading, isAuthenticated, router]);

  if (!mounted || isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <BackLink href="/labs" label={t("labs.backToLabs")} />
      <LabBiomarkerDetail biomarkerId={biomarkerId} />
    </div>
  );
}
