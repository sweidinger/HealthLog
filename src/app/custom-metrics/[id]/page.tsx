"use client";

/**
 * v1.25.5 — per-custom-metric detail page (`/custom-metrics/[id]`).
 *
 * Owns auth + the back link to the Measurements surface and hands the metric id
 * to `<CustomMetricDetail>`, which carries the heading, the trend chart with
 * the target band, the stat strip, and the value controls.
 */
import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { CustomMetricDetail } from "@/components/custom-metrics/custom-metric-detail";
import { BackLink } from "@/components/ui/back-link";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";

export default function CustomMetricDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
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
      <BackLink
        href="/measurements"
        label={t("customMetrics.backToMeasurements")}
      />
      <CustomMetricDetail customMetricId={id} />
    </div>
  );
}
