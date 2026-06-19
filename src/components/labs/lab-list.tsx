"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, FlaskConical } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api/api-fetch";
import { formatDate } from "@/lib/format";
import { formatReferenceRange } from "@/lib/labs/reference-range";
import { formatLabValue } from "@/lib/labs/format-value";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { applyOrder, useModuleListPrefs } from "@/lib/module-list-prefs";

import { LabTrendSparkline } from "./lab-trend-sparkline";
import { ReferenceRangeBadge } from "./reference-range-badge";
import type { LabResultDto, LabResultListResponse } from "./types";

interface MarkerGroup {
  /** Stable group key: the biomarker id, or `analyte:<lower>` for legacy rows. */
  key: string;
  /** Link target when the group is catalog-linked; null for legacy rows. */
  biomarkerId: string | null;
  analyte: string;
  panel: string | null;
  unit: string;
  readings: LabResultDto[];
  latest: LabResultDto;
}

/**
 * Group readings by their linked biomarker (or, for legacy un-linked rows,
 * case-insensitively by analyte). A catalog-linked group deep-links to its
 * detail chart; legacy groups render inert until the backfill links them.
 */
function groupReadings(results: LabResultDto[]): MarkerGroup[] {
  const byKey = new Map<string, LabResultDto[]>();
  for (const r of results) {
    const key = r.biomarkerId
      ? `bm:${r.biomarkerId}`
      : `analyte:${r.analyte.toLowerCase()}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(r);
    else byKey.set(key, [r]);
  }

  const groups: MarkerGroup[] = [];
  for (const [key, readings] of byKey.entries()) {
    const ordered = [...readings].sort(
      (a, b) => new Date(a.takenAt).getTime() - new Date(b.takenAt).getTime(),
    );
    const latest = ordered[ordered.length - 1];
    groups.push({
      key,
      biomarkerId: latest.biomarkerId,
      analyte: latest.analyte,
      panel: latest.panel,
      unit: latest.unit,
      readings: ordered,
      latest,
    });
  }
  return groups.sort(
    (a, b) =>
      new Date(b.latest.takenAt).getTime() -
      new Date(a.latest.takenAt).getTime(),
  );
}

export function LabList({ onAddFirst }: { onAddFirst?: () => void } = {}) {
  const { t } = useTranslations();
  const { prefs } = useModuleListPrefs("labs");

  const listKey = queryKeys.labResultsList({
    biomarkerId: undefined,
    analyte: undefined,
    panel: undefined,
    from: undefined,
    to: undefined,
    page: 0,
    sortDir: "desc",
  });

  const { data, isLoading, isError } = useQuery({
    queryKey: listKey,
    queryFn: () =>
      apiGet<LabResultListResponse>("/api/labs?limit=500&sortDir=desc"),
  });

  const groups = useMemo(() => {
    const base = groupReadings(data?.results ?? []);
    // v1.18.6 (MOD-04) — honour the user's Labs sort choice. `groupReadings`
    // already returns most-recent-first; `recentAsc` reverses, and `manual`
    // applies the persisted biomarker order (legacy un-linked groups, which
    // carry no biomarkerId, sort after the ordered block).
    if (prefs.sortDir === "recentAsc") return [...base].reverse();
    if (prefs.sortDir === "manual") {
      return applyOrder(base, prefs.order, (g) => g.biomarkerId ?? g.key);
    }
    return base;
  }, [data?.results, prefs.sortDir, prefs.order]);

  // The list caps at 500 rows server-side (the `limit` ceiling). Surface a
  // calm "showing latest N of M" hint when the cap truncates so the count is
  // never silently wrong — proper cursor paging is a later iteration.
  const total = data?.meta?.total ?? 0;
  const shown = data?.results?.length ?? 0;
  const truncated = total > shown;

  if (isLoading) {
    return (
      <div className="space-y-3" data-slot="lab-list-loading">
        {Array.from({ length: 3 }, (_, i) => (
          <Card key={i} aria-hidden="true">
            <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
              <Skeleton className="h-8 w-24 self-end sm:self-center" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <p className="text-destructive py-8 text-center text-sm">
        {t("labs.loadError")}
      </p>
    );
  }

  if (groups.length === 0) {
    return (
      <EmptyState
        icon={<FlaskConical className="size-6" />}
        title={t("labs.emptyTitle")}
        description={t("labs.emptyDescription")}
        action={
          onAddFirst ? (
            <Button onClick={onAddFirst}>{t("labs.addFirst")}</Button>
          ) : undefined
        }
      />
    );
  }

  // v1.18.6 (MOD-03) — compact list view: one bordered card holding tight
  // divided rows instead of a card per biomarker. The card view stays the
  // default; this is the denser alternative the settings toggle selects.
  if (prefs.view === "list") {
    return (
      <div className="space-y-3">
        {truncated ? (
          <p className="text-muted-foreground text-xs">
            {t("labs.showingLatestOf", { shown, total })}
          </p>
        ) : null}
        <Card>
          <CardContent className="divide-border divide-y p-0">
            {groups.map((group) => {
              const row = (
                <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                      <span className="truncate font-medium">
                        {group.analyte}
                      </span>
                      <ReferenceRangeBadge status={group.latest.rangeStatus} />
                    </div>
                    <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                      <span className="text-foreground font-semibold tabular-nums">
                        {formatLabValue(group.latest.value)} {group.latest.unit}
                      </span>
                      <span>{formatDate(group.latest.takenAt)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <LabTrendSparkline
                      values={group.readings.map((r) => r.value)}
                    />
                    {group.biomarkerId ? (
                      <ChevronRight className="text-muted-foreground h-4 w-4 shrink-0" />
                    ) : null}
                  </div>
                </div>
              );
              return group.biomarkerId ? (
                <Link
                  key={group.key}
                  href={`/labs/${group.biomarkerId}`}
                  className="hover:bg-muted/40 block transition-colors"
                >
                  {row}
                </Link>
              ) : (
                <div key={group.key}>{row}</div>
              );
            })}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {truncated ? (
        <p className="text-muted-foreground text-xs">
          {t("labs.showingLatestOf", { shown, total })}
        </p>
      ) : null}
      {groups.map((group) => {
        const body = (
          <>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                <span className="font-medium">{group.analyte}</span>
                {group.panel ? (
                  <span className="text-muted-foreground text-xs font-normal">
                    {group.panel}
                  </span>
                ) : null}
                <ReferenceRangeBadge status={group.latest.rangeStatus} />
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between gap-3">
                <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-sm">
                  <span className="text-foreground font-semibold tabular-nums">
                    {formatLabValue(group.latest.value)} {group.latest.unit}
                  </span>
                  {group.latest.referenceLow !== null ||
                  group.latest.referenceHigh !== null ? (
                    <span className="text-xs">
                      {t("labs.referenceLabel")}{" "}
                      {formatReferenceRange(
                        group.latest.referenceLow,
                        group.latest.referenceHigh,
                        formatLabValue,
                      )}
                    </span>
                  ) : null}
                  <span className="text-xs">
                    {formatDate(group.latest.takenAt)}
                  </span>
                  {group.readings.length > 1 ? (
                    <span className="text-xs">
                      {t("labs.readingsCount", {
                        count: group.readings.length,
                      })}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <LabTrendSparkline
                    values={group.readings.map((r) => r.value)}
                  />
                  {group.biomarkerId ? (
                    <ChevronRight className="text-muted-foreground h-4 w-4 shrink-0" />
                  ) : null}
                </div>
              </div>
            </CardContent>
          </>
        );

        // Catalog-linked groups deep-link to the per-biomarker detail chart.
        // Legacy un-linked groups render as a plain card until the backfill
        // links them (or the user re-adds via the structured path).
        return group.biomarkerId ? (
          <Link
            key={group.key}
            href={`/labs/${group.biomarkerId}`}
            className="block"
          >
            <Card className="hover:bg-muted/40 transition-colors">{body}</Card>
          </Link>
        ) : (
          <Card key={group.key}>{body}</Card>
        );
      })}
    </div>
  );
}
