"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Loader2, Pill } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { nextStatusPollInterval } from "@/hooks/use-insight-status";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Progress } from "@/components/ui/progress";
import { ComplianceHeatmap } from "@/components/charts/compliance-heatmap";
import { CoachLaunchButton } from "@/components/insights/coach-launch-button";
import { InsightStatusCard } from "@/components/insights/insight-status-card";
import { MetricTargetSummary } from "@/components/insights/metric-target-summary";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { TileHeader } from "@/components/insights/tile-header";

/**
 * v1.4.25 W4 — `/insights/medications`.
 *
 * Routed Medication-Compliance sub-page. Mirrors the per-medication
 * grid from the v1.4.24 mother page (compliance bars + heatmap +
 * per-med assistant sentence) plus the section-level assessment.
 *
 * No `<HealthChart>` here — medication compliance is event-driven, so
 * the data path runs through `/api/insights/comprehensive` +
 * `/api/medications/[id]/compliance` instead of the measurement-series
 * Prisma path.
 *
 * Empty-state: zero medications → big "Add your first medication" CTA.
 */

interface MedicationEntry {
  id: string;
  name: string;
  dose: string;
  category: "BLOOD_PRESSURE" | "VITAMIN" | "OTHER";
  compliance7: number;
  compliance30: number;
  streak: number;
  taken7: number;
  skipped7: number;
  missed7: number;
}

interface ComprehensiveMedicationData {
  medications: MedicationEntry[];
}

interface MedicationComplianceStatusData {
  hasProvider: boolean;
  summary: string | null;
  medications: Array<{ medicationId: string; text: string }>;
  cached: boolean;
  updatedAt: string | null;
  // v1.8.3 — read-only route returns preparing:true with summary:null on a
  // cache miss while the worker warms the assessment; the card polls until
  // it lands. See `use-insight-status.ts` for the shared rationale.
  preparing?: boolean;
  // v1.9.0 — last-good narrative served while a refresh is in flight; the
  // card keeps polling (bounded) so the open page upgrades in-session.
  revalidating?: boolean;
}

// v1.8.3 — client ceiling on the round-trip, mirroring the shared
// `use-insight-status` hook so the medication-compliance card never awaits
// an uncapped LLM round-trip on navigation. The preparing-poll cadence and
// its attempt ceiling come from the shared `nextStatusPollInterval` helper.
const MED_STATUS_TIMEOUT_MS = 8_000;

interface MedicationDailyData {
  expected: number;
  taken: number;
  skipped: number;
  onTime?: number;
  late?: number;
  veryLate?: number;
}

interface MedicationComplianceDailyResponse {
  dailyCompliance: Record<string, MedicationDailyData>;
}

export default function InsightsMedikamentePage() {
  const { isAuthenticated } = useAuth();
  const { t, locale } = useTranslations();

  const { data: comprehensive, isLoading: isComprehensiveLoading } = useQuery({
    queryKey: queryKeys.insightsComprehensive(),
    queryFn: async () => {
      const res = await fetch("/api/insights/comprehensive");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as ComprehensiveMedicationData;
    },
    enabled: isAuthenticated,
  });

  const { data: status, isLoading: isStatusLoading } = useQuery({
    queryKey: queryKeys.insightsMedicationComplianceStatus(locale),
    queryFn: async () => {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(
        () => controller.abort(),
        MED_STATUS_TIMEOUT_MS,
      );
      try {
        const res = await fetch(
          `/api/insights/medication-compliance-status?locale=${locale}`,
          { signal: controller.signal },
        );
        if (!res.ok) throw new Error("Failed");
        const json = await res.json();
        return json.data as MedicationComplianceStatusData;
      } finally {
        clearTimeout(timeoutHandle);
      }
    },
    enabled: isAuthenticated,
    staleTime: 60 * 1000,
    retry: 0,
    // v1.8.4 — bounded preparing poll: stop after the shared attempt
    // ceiling so a persistently failing generation can't poll an open
    // page forever.
    refetchInterval: (query) =>
      nextStatusPollInterval(
        query.state.data?.preparing,
        query.state.dataUpdateCount,
        query.state.data?.revalidating,
      ),
  });

  const medications = comprehensive?.medications ?? [];
  const medicationSummaryById = new Map(
    (status?.medications ?? []).map((entry) => [
      entry.medicationId,
      entry.text,
    ]),
  );

  if (isComprehensiveLoading) {
    return (
      <SubPageShell
        title={t("insights.medicationCompliance")}
        explainerMetric="medications"
      >
        <div className="flex items-center justify-center py-12">
          <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
        </div>
      </SubPageShell>
    );
  }

  if (medications.length === 0) {
    // v1.4.27 F17 — medication compliance is event-driven so the
    // gate reads `medications.length > 0`. CTA targets `/medications`
    // (the dedicated medication-management surface).
    return (
      <SubPageShell
        title={t("insights.medicationCompliance")}
        explainerMetric="medications"
      >
        <EmptyState
          icon={<Pill className="size-6" />}
          title={t("insights.emptyState.medication.title")}
          description={t("insights.emptyState.medication.description")}
          ctaSize="lg"
          action={
            <Button size="sm" asChild>
              <Link href="/medications">
                {t("insights.emptyState.medication.cta")}
              </Link>
            </Button>
          }
        />
        <CoachLaunchButton
          prefill="I haven't added any medications yet — what should I know before I start tracking medication compliance here?"
        />
      </SubPageShell>
    );
  }

  return (
    <SubPageShell
      title={t("insights.medicationCompliance")}
      description={t("insights.subPage.medikamenteDescription")}
      explainerMetric="medications"
      coachLaunch
    >
      {/* No `<MetricRangeControls>` here: medication compliance is
          event-driven, not a MeasurementType series, so the period-over-period
          range read has nothing to aggregate. */}
      <div
        className={
          medications.length >= 2 ? "grid gap-4 sm:grid-cols-2" : "grid gap-4"
        }
      >
        {medications.map((med) => {
          const medicationSummary = medicationSummaryById.get(med.id);
          // v1.12.6 — the per-medication compliance card harmonises with
          // the rest of the Insights tiles: its header runs through the
          // canonical `<TileHeader>` (Pill glyph + med name as the white
          // heading), and the dose + category + streak fold into one
          // compact muted line below it. Every datum the previous, taller
          // card carried (7d/30d bars, taken/skipped/missed, heatmap,
          // per-med assistant sentence) stays — only the vertical rhythm
          // tightens.
          const categoryLabel =
            med.category === "BLOOD_PRESSURE"
              ? t("medications.categoryBloodPressure")
              : med.category === "VITAMIN"
                ? t("medications.categoryVitamin")
                : t("medications.categoryOther");
          return (
            <Card key={med.id} className="gap-2 py-4 md:gap-3 md:py-5">
              <CardHeader className="pb-0">
                <TileHeader icon={Pill} title={med.name} />
                <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span className="font-medium tabular-nums">{med.dose}</span>
                  <span aria-hidden="true">·</span>
                  <span>{categoryLabel}</span>
                  {med.streak > 0 ? (
                    <Badge variant="outline" className="ml-auto shrink-0 text-xs">
                      {t("insights.dayStreak", { count: med.streak })}
                    </Badge>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="space-y-2.5">
                <div className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span>{t("insights.compliance7d")}</span>
                    <span className="font-medium">{med.compliance7}%</span>
                  </div>
                  {/* v1.4.33 IW9 — aria-label so the bar has an
                      accessible name (Lighthouse a11y 91/94). */}
                  <Progress
                    value={med.compliance7}
                    className="h-1.5"
                    aria-label={t("insights.compliance7d")}
                  />
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span>{t("insights.compliance30d")}</span>
                    <span className="font-medium">{med.compliance30}%</span>
                  </div>
                  <Progress
                    value={med.compliance30}
                    className="h-1.5"
                    aria-label={t("insights.compliance30d")}
                  />
                </div>
                <div className="text-muted-foreground flex justify-between text-xs">
                  <span>
                    <span className="text-dracula-green">{med.taken7}</span>{" "}
                    {t("insights.taken")}
                  </span>
                  <span>
                    <span className="text-dracula-orange">
                      {med.skipped7}
                    </span>{" "}
                    {t("insights.skipped")}
                  </span>
                  <span>
                    <span className="text-dracula-red">{med.missed7}</span>{" "}
                    {t("insights.missed")}
                  </span>
                </div>
                <MedicationComplianceCalendar medicationId={med.id} />
                {medicationSummary ? (
                  <p className="text-muted-foreground text-sm leading-6">
                    {medicationSummary}
                  </p>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <MetricTargetSummary slug="medications" />

      {/* v1.12.2 — the assessment is the LAST block on every bespoke
          metric-detail page, matching the canonical spine the generic
          scaffold renders. This card reads the medication-compliance
          status route, which carries a richer envelope (`summary` +
          per-medication `text`) than the standard `text`-only generators,
          so it keeps its inline wiring rather than the shared
          `<SlugInsightStatusCard>` seam. */}
      <InsightStatusCard
        title={t("insights.assessmentTitle")}
        icon={<Pill className="h-5 w-5" />}
        text={status?.summary ?? null}
        hasProvider={status?.hasProvider ?? false}
        updatedAt={status?.updatedAt ?? null}
        loading={isStatusLoading}
        preparing={status?.preparing ?? false}
      />
    </SubPageShell>
  );
}

function MedicationComplianceCalendar({
  medicationId,
}: {
  medicationId: string;
}) {
  const { t } = useTranslations();
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.medicationComplianceChart(medicationId),
    queryFn: async () => {
      const res = await fetch(`/api/medications/${medicationId}/compliance`);
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as MedicationComplianceDailyResponse;
    },
    enabled: !!medicationId,
    staleTime: 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 className="text-primary h-4 w-4 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  if (!data?.dailyCompliance) {
    return (
      <div className="text-muted-foreground rounded-lg border border-dashed px-3 py-4 text-xs">
        {t("insights.complianceNoData")}
      </div>
    );
  }

  return (
    <div className="w-full">
      <ComplianceHeatmap dailyCompliance={data.dailyCompliance} stretch />
    </div>
  );
}
