"use client";

import { use } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "@/components/measurements/measurement-list-meta";
import { Button } from "@/components/ui/button";
import { MeasurementList } from "@/components/measurements/measurement-list";
import { SubPageShell } from "@/components/insights/sub-page-shell";

/**
 * v1.8.5 — `/insights/values/[type]`.
 *
 * The "show all readings" subpage for a single metric. The insights
 * category pages link here with their `MeasurementType` as the route
 * segment (e.g. `/insights/values/WEIGHT`); this page pins the existing
 * `<MeasurementList>` to that type via `lockedType`, giving the user the
 * full paginated, inline-editable raw-readings view without rebuilding
 * any of the list machinery.
 *
 * A single dynamic route serves every metric — the enum guard rejects an
 * unknown segment with a 404 rather than rendering an empty list for a
 * typo'd type.
 */
export default function InsightsMetricValuesPage({
  params,
}: {
  params: Promise<{ type: string }>;
}) {
  const { t } = useTranslations();
  const { type } = use(params);

  // Reject any segment that is not a real MeasurementType so a typo'd
  // deep-link 404s instead of mounting a blank list.
  if (!measurementTypeEnum.options.includes(type as never)) {
    notFound();
  }

  const labelKey = MEASUREMENT_TYPE_LABEL_KEYS[type];
  const metricLabel = labelKey ? t(labelKey) : type;

  return (
    <SubPageShell
      title={t("insights.subPage.valuesPageTitle", { metric: metricLabel })}
      description={t("insights.subPage.valuesPageDescription")}
      backLink={
        <Button
          asChild
          variant="ghost"
          size="sm"
          data-slot="metric-values-back"
          className="-ml-2 w-fit"
        >
          <Link href="/insights">
            <ArrowLeft className="mr-1 size-4" aria-hidden="true" />
            {t("insights.subPage.valuesBack")}
          </Link>
        </Button>
      }
    >
      <MeasurementList lockedType={type} />
    </SubPageShell>
  );
}
