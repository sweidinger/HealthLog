"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ChevronRight,
  Droplet,
  Ear,
  Footprints,
  HeartPulse,
  Moon,
  Pill,
  Scale,
  Siren,
  Sun,
  Waves,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { useAuth } from "@/hooks/use-auth";
import { useWorkouts } from "@/hooks/use-workouts";
import { useTranslations } from "@/lib/i18n/context";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { useAnalyticsQuery } from "@/lib/queries/use-analytics-query";
import {
  hasMetricData,
  type InsightInputs,
} from "@/lib/insights/metric-availability";
import {
  CATALOG_GROUP_HEADER_KEYS,
  CATALOG_GROUP_ORDER,
  catalogEntriesByGroup,
  type CatalogEntry,
} from "@/lib/insights/metric-catalog";
import type { ManagerGroup } from "@/lib/insights/sub-page-metric";

/**
 * `/insights/catalog` — "what can HealthLog track" (2026-07-17
 * discoverability audit, recommendation R1).
 *
 * A single, on-purpose surface: every metric domain HealthLog supports,
 * grouped, each row showing its name, whether THIS account has data for
 * it yet, what supplies it (device-concrete, vendor-neutral), and — when
 * absent and a device could supply it — a quiet CTA into
 * `/settings/integrations`. This is deliberately NOT surfaced in the
 * daily nav: metrics with no data stay hidden from the dashboard /
 * Insights tab strip by design (`metric-availability.ts` — "a metric
 * with zero observations doesn't surface a navigation target the user
 * can't act on"), so an account with a sparse device kit would otherwise
 * have no reachable evidence a capability exists at all. This page is
 * that evidence, reached only when the user navigates here on purpose
 * (the quiet "All metrics" pill at the tail of the Insights tab strip,
 * see `insights-tab-strip.tsx`).
 *
 * Presence per row reuses the EXACT gating inputs the tab strip / nav
 * pills already compute (`hasMetricData` over the shared analytics +
 * comprehensive + workouts + nutrients reads) — this page adds no new
 * server route and no new derivation of "does the user have this metric".
 * The ECG row is the one exception: ECG carries no `MeasurementType`, so
 * its presence comes from the same `hasRecordings` probe the overview's
 * `<EcgSection>` already reads.
 */

interface ComprehensivePayload {
  moodSummary: { count: number } | null;
  medications: Array<{ id: string }>;
}

const GROUP_ICONS: Record<ManagerGroup, LucideIcon> = {
  vitals: Activity,
  body: Scale,
  activity: Footprints,
  sleep: Moon,
  cardiovascular: HeartPulse,
  hearing: Ear,
  environment: Sun,
  metabolic: Droplet,
  mood: Waves,
  events: Pill,
};

function StatusBadge({ present }: { present: boolean }) {
  const { t } = useTranslations();
  if (present) {
    return (
      <Badge
        variant="outline"
        className="border-success/40 bg-success/15 text-success shrink-0"
      >
        {t("metricCatalog.statusPresent")}
      </Badge>
    );
  }
  return (
    <span className="text-muted-foreground shrink-0 text-xs">
      {t("metricCatalog.statusAbsent")}
    </span>
  );
}

function CatalogRow({
  entry,
  present,
}: {
  entry: CatalogEntry;
  present: boolean | null;
}) {
  const { t } = useTranslations();

  if (entry.kind === "info") {
    return (
      <div data-slot="catalog-row-info" className="flex items-start gap-2 py-2">
        <Siren className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-sm font-medium">
            {t(entry.nameKey)}
          </p>
          <p className="text-muted-foreground text-xs">{t(entry.sourceKey)}</p>
        </div>
      </div>
    );
  }

  const isPresent = present === true;

  return (
    <div
      data-slot="catalog-row"
      data-metric-id={entry.id}
      className="flex items-start justify-between gap-3 py-2"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-foreground text-sm font-medium">
            {t(entry.nameKey)}
          </span>
          <StatusBadge present={isPresent} />
        </div>
        <p className="text-muted-foreground text-xs">{t(entry.sourceKey)}</p>
      </div>
      <div className="shrink-0">
        {isPresent && entry.href ? (
          <Button size="sm" variant="ghost" asChild>
            <Link href={entry.href}>
              {t("metricCatalog.viewCta")}
              <ChevronRight className="size-3.5" />
            </Link>
          </Button>
        ) : !isPresent && entry.connectable ? (
          <Button size="sm" variant="outline" asChild>
            <Link href="/settings/integrations">
              {t("metricCatalog.connectCta")}
            </Link>
          </Button>
        ) : !isPresent && entry.manualHref && entry.manualCtaKey ? (
          <Button size="sm" variant="outline" asChild>
            <Link href={entry.manualHref}>{t(entry.manualCtaKey)}</Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export default function MetricCatalogPage() {
  const { t } = useTranslations();
  const { isAuthenticated, user } = useAuth();

  const analyticsQuery = useAnalyticsQuery({ slice: "summaries" });

  const comprehensiveQuery = useQuery({
    queryKey: queryKeys.insightsComprehensive(),
    queryFn: () => apiGet<ComprehensivePayload>("/api/insights/comprehensive"),
    enabled: isAuthenticated,
  });

  const workoutsProbe = useWorkouts({ limit: 1 });

  const nutrientsModuleEnabled = user?.modules?.nutrients === true;
  const nutrientsProbe = useQuery({
    queryKey: queryKeys.nutrientIntake(1),
    queryFn: () =>
      apiGet<{ nutrients: Array<{ nutrient: string }> }>(
        "/api/nutrients?days=1",
      ),
    enabled: isAuthenticated && nutrientsModuleEnabled,
  });

  const ecgQuery = useQuery({
    queryKey: queryKeys.insightsEcgList(),
    queryFn: () => apiGet<{ hasRecordings: boolean }>("/api/insights/ecg"),
    enabled: isAuthenticated,
  });

  const availability: InsightInputs | undefined = isAuthenticated
    ? {
        summaries: analyticsQuery.data?.summaries,
        hasMood: (comprehensiveQuery.data?.moodSummary?.count ?? 0) > 0,
        hasMedication: (comprehensiveQuery.data?.medications?.length ?? 0) > 0,
        hasWorkouts: (workoutsProbe.data?.workouts.length ?? 0) > 0,
        hasNutrients: (nutrientsProbe.data?.nutrients.length ?? 0) > 0,
      }
    : undefined;

  const grouped = catalogEntriesByGroup();

  function isPresent(entry: CatalogEntry): boolean | null {
    if (entry.kind === "info") return null;
    if (entry.id === "ecg") return ecgQuery.data?.hasRecordings === true;
    if (!availability || !entry.metric) return false;
    return hasMetricData(entry.metric, availability);
  }

  return (
    <SubPageShell
      title={t("metricCatalog.title")}
      description={t("metricCatalog.description")}
    >
      <div className="space-y-6">
        {CATALOG_GROUP_ORDER.map((group) => {
          const entries = grouped.get(group) ?? [];
          if (entries.length === 0) return null;
          const Icon = GROUP_ICONS[group];
          // Nutrients rides the metabolic group but needs a module-off
          // branch (B1 — the tab-strip pill requires the module ON before
          // it ever probes for rows, so a module-off account never saw
          // the in-context enable CTA; this row is the fix).
          return (
            <Card
              key={group}
              data-slot="catalog-group"
              className="gap-2 py-3 md:py-4"
            >
              <CardHeader>
                <TileHeader
                  icon={Icon}
                  title={t(CATALOG_GROUP_HEADER_KEYS[group])}
                />
              </CardHeader>
              <CardContent>
                <div className="divide-border divide-y">
                  {entries.map((entry) => {
                    if (entry.id === "nutrients" && !nutrientsModuleEnabled) {
                      return (
                        <div
                          key={entry.id}
                          data-slot="catalog-row"
                          data-metric-id="nutrients"
                          className="flex items-start justify-between gap-3 py-2"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-foreground text-sm font-medium">
                                {t(entry.nameKey)}
                              </span>
                              <span className="text-muted-foreground shrink-0 text-xs">
                                {t("metricCatalog.statusModuleOff")}
                              </span>
                            </div>
                            <p className="text-muted-foreground text-xs">
                              {t("nutrients.page.moduleOffDescription")}
                            </p>
                          </div>
                          <div className="shrink-0">
                            <Button size="sm" variant="outline" asChild>
                              <Link href="/settings/modules">
                                {t("nutrients.page.moduleOffCta")}
                              </Link>
                            </Button>
                          </div>
                        </div>
                      );
                    }
                    return (
                      <CatalogRow
                        key={entry.id}
                        entry={entry}
                        present={isPresent(entry)}
                      />
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </SubPageShell>
  );
}
