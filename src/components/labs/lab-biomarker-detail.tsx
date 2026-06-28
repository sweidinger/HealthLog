"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  FlaskConical,
  ListOrdered,
  Pencil,
  Plus,
  SlidersHorizontal,
} from "lucide-react";
import { toast } from "sonner";

import { DeleteButton } from "@/components/data-list";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { InsightStatusCard } from "@/components/insights/insight-status-card";
import { MetricStatStrip } from "@/components/insights/metric-stat-strip";
import { useInsightBiomarkerAssessment } from "@/hooks/use-insight-status";
import { useMounted } from "@/hooks/use-mounted";
import { apiDelete, apiGet, apiPut } from "@/lib/api/api-fetch";
import { summarize, type DataSummary } from "@/lib/analytics/trends";
import { BIOMARKER_CATALOG } from "@/lib/labs/biomarker-catalog";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/query-keys";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import { ChartErrorBoundary } from "@/components/charts/chart-error-state";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { importWithRetry } from "@/lib/retry-import";

import { BiomarkerForm } from "./biomarker-form";
import { LabForm } from "./lab-form";
import type {
  BiomarkerDto,
  LabResultDto,
  LabResultListResponse,
} from "./types";

// v1.18.11 (W5 perf) — defer the recharts biomarker chart through
// `next/dynamic` so recharts is off `/labs/[biomarkerId]`'s first-load JS.
// The chart only paints once the reading list resolves; the `<ChartSkeleton>`
// loading shell matches the in-card chart footprint so the layout is stable.
const LabBiomarkerChartLazy = dynamic(
  () =>
    importWithRetry(() => import("./lab-biomarker-chart")).then((mod) => ({
      default: mod.LabBiomarkerChart,
    })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
function LabBiomarkerChart(
  props: ComponentProps<typeof LabBiomarkerChartLazy>,
) {
  return (
    <ChartErrorBoundary>
      <LabBiomarkerChartLazy {...props} />
    </ChartErrorBoundary>
  );
}

// Page size for the offset-paginated reading feed. The server caps a single
// read at 500 (`listLabResultsSchema`); this stays well under that and keeps
// the first paint light, with "Load more" pulling subsequent pages.
const READINGS_PAGE_SIZE = 200;

/**
 * v1.18.1 — per-biomarker detail: heading + current-value badge, the proper
 * dashboard-style chart with the reference band, and the editable reading
 * history. "Add value" pre-selects this biomarker so the user never re-picks
 * it. Mirrors the measurement-detail layout.
 */
export function LabBiomarkerDetail({ biomarkerId }: { biomarkerId: string }) {
  const { t } = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();
  // v1.24 — the per-marker description used to live on the labs overview rows.
  // It belongs on the detail page beneath the heading (mirroring the metric
  // pages' explainer caption). Resolve the catalog slug from the marker name
  // exactly as the overview did, then fall back to the user's own `context`.
  const slugByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const seed of BIOMARKER_CATALOG) {
      const norm = t(`labs.catalog.${seed.slug}`).trim().toLowerCase();
      if (norm) map.set(norm, seed.slug);
    }
    return map;
  }, [t]);
  const [addOpen, setAddOpen] = useState(false);
  // Sticky-footer slot for the add-value sheet (the form portals here).
  const [addFooterEl, setAddFooterEl] = useState<HTMLDivElement | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editFooterEl, setEditFooterEl] = useState<HTMLDivElement | null>(null);
  // v1.24 — focused "adjust target range" sheet. Edits only the reference
  // bounds (the full marker editor lives behind the pencil); seeded from the
  // marker each time it opens.
  const [rangeOpen, setRangeOpen] = useState(false);
  const [lowerInput, setLowerInput] = useState("");
  const [upperInput, setUpperInput] = useState("");

  const { data: marker, isError: markerError } = useQuery({
    queryKey: queryKeys.biomarkerDetail(biomarkerId),
    queryFn: () => apiGet<BiomarkerDto>(`/api/biomarkers/${biomarkerId}`),
  });

  // v1.25 — offset-paginated reading feed. The page no longer fetches a single
  // `limit=500` window (which silently truncated a marker once it crossed 500
  // readings); it loads a page at a time and a "Load more" control reveals the
  // rest. The chart + stat strip render the accumulated set, so loading more
  // also extends the trend rather than re-fetching the whole history.
  const {
    data: list,
    isLoading,
    isError: listError,
  } = useInfiniteQuery({
    queryKey: queryKeys.labResultsInfinite({ biomarkerId, sortDir: "desc" }),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      apiGet<LabResultListResponse>(
        `/api/labs?biomarkerId=${encodeURIComponent(
          biomarkerId,
        )}&limit=${READINGS_PAGE_SIZE}&offset=${pageParam}&sortDir=desc`,
      ),
    getNextPageParam: (lastPage) => {
      const next = lastPage.meta.offset + lastPage.meta.limit;
      return next < lastPage.meta.total ? next : undefined;
    },
  });

  const readings: LabResultDto[] = useMemo(
    () => list?.pages.flatMap((p) => p.results) ?? [],
    [list],
  );
  const latest =
    readings.length > 0
      ? [...readings].sort(
          (a, b) =>
            new Date(b.takenAt).getTime() - new Date(a.takenAt).getTime(),
        )[0]
      : null;

  // v1.24 — the numbers-first stat strip + the AI assessment card mirror the
  // metric sub-pages. The strip reads a client-side `DataSummary` over the
  // numeric readings; the assessment card consumes the read-only biomarker
  // route (stale-while-revalidate, regenerated only on a new reading). The
  // strip + card both self-gate on data, so a qualitative-only or brand-new
  // marker paints neither.
  const numericReadings = useMemo(
    () => readings.filter((r) => r.value !== null),
    [readings],
  );
  // A marker is qualitative when it has readings but none of them carry a
  // numeric value — a stat strip / chart make no sense, so the page shows the
  // latest result text + assessment + the history (via the values sub-page).
  const isQualitative = readings.length > 0 && numericReadings.length === 0;
  const summary = useMemo<DataSummary | null>(
    () =>
      numericReadings.length > 0
        ? summarize(
            numericReadings.map((r) => ({
              date: new Date(r.takenAt),
              value: r.value as number,
            })),
          )
        : null,
    [numericReadings],
  );
  const mounted = useMounted();
  const { data: assessment, isLoading: assessmentLoading } =
    useInsightBiomarkerAssessment(biomarkerId, readings.length > 0);

  function afterAdd() {
    setAddOpen(false);
    queryClient.invalidateQueries({ queryKey: queryKeys.labResults() });
  }

  function afterEditMarker() {
    setEditOpen(false);
    queryClient.invalidateQueries({
      queryKey: queryKeys.biomarkerDetail(biomarkerId),
    });
    queryClient.invalidateQueries({ queryKey: queryKeys.biomarkers() });
    // Resolved name / unit / range on every reading derives from the marker.
    queryClient.invalidateQueries({ queryKey: queryKeys.labResults() });
  }

  // v1.18.9 (#41/#3) — delete the biomarker directly from its detail page so
  // a stray marker is removable without a Settings detour. `onDelete: SetNull`
  // keeps the readings and unlinks them. On success, invalidate the catalog +
  // result list and return to the labs surface.
  const deleteMarker = useMutation({
    mutationFn: () => apiDelete(`/api/biomarkers/${biomarkerId}`),
    onSuccess: () => {
      toast.success(t("labs.biomarker.deletedToast"));
      queryClient.invalidateQueries({ queryKey: queryKeys.biomarkers() });
      queryClient.invalidateQueries({ queryKey: queryKeys.labResults() });
      router.push("/labs");
    },
    onError: () => toast.error(t("labs.biomarker.deleteError")),
  });

  function openRange() {
    setLowerInput(marker?.lowerBound != null ? String(marker.lowerBound) : "");
    setUpperInput(marker?.upperBound != null ? String(marker.upperBound) : "");
    setRangeOpen(true);
  }

  const saveRange = useMutation({
    mutationFn: () => {
      const lower = lowerInput.trim() === "" ? null : Number(lowerInput);
      const upper = upperInput.trim() === "" ? null : Number(upperInput);
      return apiPut(`/api/biomarkers/${biomarkerId}`, {
        lowerBound: lower,
        upperBound: upper,
      });
    },
    onSuccess: () => {
      toast.success(t("labs.biomarker.targetRange.savedToast"));
      setRangeOpen(false);
      queryClient.invalidateQueries({
        queryKey: queryKeys.biomarkerDetail(biomarkerId),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.biomarkers() });
      queryClient.invalidateQueries({ queryKey: queryKeys.labResults() });
    },
    onError: () => toast.error(t("labs.biomarker.targetRange.saveError")),
  });

  if (markerError || listError) {
    return (
      <p className="text-destructive py-8 text-center text-sm">
        {t("labs.loadError")}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">
            {marker?.name ?? <Skeleton className="h-7 w-32" />}
          </h1>
          {marker?.unit ? (
            <p className="text-muted-foreground text-xs sm:text-sm">
              {marker.unit}
              {marker.panel ? ` · ${marker.panel}` : ""}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* v1.25.1 — "show all readings" rides the header cluster as an icon
              button, mirroring the metric sub-pages' `<SubPageShell>` control.
              The full reading feed lives on `/labs/[biomarkerId]/values`; the
              detail page keeps the numbers-first spine. */}
          {readings.length > 0 ? (
            <Button
              asChild
              variant="ghost"
              size="icon"
              data-slot="lab-show-all-values"
              className={cn(
                "text-muted-foreground hover:text-foreground relative size-10",
                "before:absolute before:-inset-1.5 before:content-['']",
              )}
            >
              <Link
                href={`/labs/${biomarkerId}/values`}
                aria-label={t("insights.subPage.showAllValues")}
                title={t("insights.subPage.showAllValues")}
              >
                <ListOrdered className="size-4" aria-hidden="true" />
              </Link>
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
            onClick={() => setEditOpen(true)}
            disabled={!marker}
            aria-label={t("labs.biomarker.edit")}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <DeleteButton
            onConfirm={() => deleteMarker.mutate()}
            title={t("labs.biomarker.deleteConfirmTitle")}
            description={t("labs.biomarker.deleteConfirmDescription")}
            confirmLabel={t("labs.biomarker.delete")}
            className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
            iconClassName="h-4 w-4"
          />
          <Button
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
            onClick={openRange}
            disabled={!marker}
            aria-label={t("labs.biomarker.targetRange.title")}
          >
            <SlidersHorizontal className="h-4 w-4" />
          </Button>
          <Button
            onClick={() => setAddOpen(true)}
            // v1.18.10 (W10) — on the narrowest phones the h1 + Edit + Delete +
            // text "Add" button crowd the row and truncate the title hard.
            // Drop the Add button to icon-only under `sm` (label kept for
            // screen readers via `aria-label`); the full text returns at `sm+`.
            className="min-h-11 min-w-11 shrink-0 sm:min-h-9 sm:min-w-0"
            aria-label={t("labs.addResult")}
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">{t("labs.addResult")}</span>
          </Button>
        </div>
      </div>

      {/* v1.25.1 — the static description leads the page, directly beneath the
          heading, mirroring the metric sub-pages' explainer caption. Resolves
          the catalog slug from the marker name, falling back to the user's own
          `context`. */}
      {(() => {
        const slug = marker?.name
          ? slugByName.get(marker.name.trim().toLowerCase())
          : undefined;
        const description = slug
          ? t(`labs.catalog.desc.${slug}`)
          : (marker?.context ?? null);
        return description ? (
          <p className="text-muted-foreground text-sm leading-relaxed">
            {description}
          </p>
        ) : null;
      })()}

      {isLoading ? (
        <Card>
          <CardContent className="pt-6">
            <Skeleton className="h-60 w-full" />
          </CardContent>
        </Card>
      ) : readings.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              icon={<FlaskConical className="size-6" />}
              title={t("labs.detail.emptyTitle")}
              description={t("labs.detail.emptyDescription")}
              action={
                <Button onClick={() => setAddOpen(true)}>
                  {t("labs.addResult")}
                </Button>
              }
            />
          </CardContent>
        </Card>
      ) : isQualitative ? (
        // Qualitative marker — no numeric strip / chart. Show the latest
        // result text on its own simple line, no unit, no range badge.
        <Card>
          <CardContent className="space-y-1 pt-6">
            <p className="text-muted-foreground text-xs">
              {t("labs.detail.latestResult")}
            </p>
            <p className="text-2xl font-bold">{latest?.valueText ?? ""}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Numbers-first stat strip — Min / Max / Median / Mean over the
              numeric readings, mirroring the metric sub-pages. */}
          <MetricStatStrip
            summary={summary}
            unit={marker?.unit ?? latest?.unit ?? ""}
            seriesLabel={marker?.name}
            icon={FlaskConical}
          />
          <Card>
            <CardContent className="pt-6">
              <LabBiomarkerChart
                readings={readings}
                unit={marker?.unit ?? latest?.unit ?? ""}
                lowerBound={marker?.lowerBound ?? null}
                upperBound={marker?.upperBound ?? null}
              />
            </CardContent>
          </Card>
        </>
      )}

      {/* AI assessment — the spine's closing block, mirroring the metric
          sub-pages (intro → stat strip → chart → assessment). The card
          self-suppresses for a qualitative-only marker (the read-only route
          returns `insufficient` without calling a provider). */}
      {readings.length > 0 ? (
        <InsightStatusCard
          title={t("insights.assessmentTitle")}
          icon={<FlaskConical className="h-5 w-5" />}
          text={assessment?.text ?? null}
          hasProvider={assessment?.hasProvider ?? false}
          updatedAt={assessment?.updatedAt ?? null}
          coachQuestion={
            marker?.name
              ? t("insights.coach.assessmentPrompt", { metric: marker.name })
              : undefined
          }
          coachAutoSend
          loading={!mounted || assessmentLoading}
          preparing={assessment?.preparing ?? false}
        />
      ) : null}

      <ResponsiveSheet
        open={addOpen}
        onOpenChange={setAddOpen}
        title={t("labs.addResult")}
        description={t("labs.addDescription")}
        footer={
          <div ref={setAddFooterEl} className="flex w-full justify-end gap-2" />
        }
      >
        <LabForm
          lockedBiomarkerId={biomarkerId}
          footerSlot={addFooterEl}
          onSuccess={afterAdd}
          onCancel={() => setAddOpen(false)}
        />
      </ResponsiveSheet>

      <ResponsiveSheet
        open={editOpen}
        onOpenChange={setEditOpen}
        title={t("labs.biomarker.editTitle")}
        description={t("labs.biomarker.defineDescription")}
        footer={
          <div
            ref={setEditFooterEl}
            className="flex w-full justify-end gap-2"
          />
        }
      >
        {marker ? (
          <BiomarkerForm
            existing={marker}
            footerSlot={editFooterEl}
            onSuccess={afterEditMarker}
            onCancel={() => setEditOpen(false)}
          />
        ) : null}
      </ResponsiveSheet>

      <ResponsiveSheet
        open={rangeOpen}
        onOpenChange={setRangeOpen}
        title={t("labs.biomarker.targetRange.title")}
        description={t("labs.biomarker.targetRange.description")}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setRangeOpen(false)}
              disabled={saveRange.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => saveRange.mutate()}
              disabled={saveRange.isPending}
            >
              {t("labs.biomarker.targetRange.save")}
            </Button>
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="biomarker-lower-bound">
              {t("labs.biomarker.form.lowerBound")}
            </Label>
            <Input
              id="biomarker-lower-bound"
              type="number"
              inputMode="decimal"
              value={lowerInput}
              onChange={(e) => setLowerInput(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="biomarker-upper-bound">
              {t("labs.biomarker.form.upperBound")}
            </Label>
            <Input
              id="biomarker-upper-bound"
              type="number"
              inputMode="decimal"
              value={upperInput}
              onChange={(e) => setUpperInput(e.target.value)}
            />
          </div>
        </div>
        {marker?.unit ? (
          <p className="text-muted-foreground mt-2 text-xs">
            {t("labs.biomarker.form.rangeHint")}
          </p>
        ) : null}
      </ResponsiveSheet>
    </div>
  );
}
