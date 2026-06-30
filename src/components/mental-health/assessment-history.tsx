"use client";

/**
 * v1.25.3 — the history card: a per-instrument trend chart over a band-shaded
 * plot, then the dated list with severity badges. Mirrors the labs detail spine
 * (chart → list) and lazy-loads Recharts through `next/dynamic` so it stays off
 * the surface's first-load JS, with a `ChartSkeleton` shell.
 *
 * PHQ-9 / GAD-7 toggle: the two instruments have different score ranges + bands,
 * so the chart paints one at a time.
 *
 * CRISIS-SAFETY: a flagged PHQ-9 row carries a discreet "support shown" marker;
 * tapping it re-surfaces the STATIC crisis-resource card derived from the row's
 * stored locale (`crisisResourcesForLocale`) — it NEVER decrypts or reveals the
 * item-9 answer, and surfacing it triggers no third-party alert. No new data
 * leaves the safety boundary.
 */
import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { ComponentProps } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ChartErrorBoundary } from "@/components/charts/chart-error-state";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { importWithRetry } from "@/lib/retry-import";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { crisisResourcesForLocale } from "@/lib/mental-health/crisis-resources";
import { Activity } from "lucide-react";

import { CrisisCard } from "./crisis-card";
import type { AssessmentRow, CrisisSet, InstrumentId } from "./types";

// Defer the recharts trend chart so recharts stays off the surface's first-load
// JS (the labs detail precedent). The `<ChartSkeleton>` shell holds the layout.
const AssessmentHistoryChartLazy = dynamic(
  () =>
    importWithRetry(() => import("./assessment-history-chart")).then((mod) => ({
      default: mod.AssessmentHistoryChart,
    })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
function AssessmentHistoryChart(
  props: ComponentProps<typeof AssessmentHistoryChartLazy>,
) {
  return (
    <ChartErrorBoundary>
      <AssessmentHistoryChartLazy {...props} />
    </ChartErrorBoundary>
  );
}

function lower(id: InstrumentId): "phq9" | "gad7" {
  return id === "PHQ9" ? "phq9" : "gad7";
}

/** Re-derive the STATIC crisis set from a row's locale — no decryption. */
function crisisFromRow(row: AssessmentRow): CrisisSet {
  const set = crisisResourcesForLocale(row.locale);
  return {
    emergencyNumber: set.emergencyNumber,
    resources: set.resources.map((r) => ({
      id: r.id,
      contacts: [...r.contacts],
    })),
  };
}

export function AssessmentHistory({
  rows,
  instrument,
}: {
  rows: AssessmentRow[];
  /**
   * Pin the history to a single instrument. When set, the PHQ-9 / GAD-7
   * toggle + the outer Card chrome are dropped — the surface is a per-
   * instrument detail (opened from an instrument card; the chrome + title
   * come from the host sheet). Unset, it renders the combined landing card
   * with the toggle, exactly as before.
   */
  instrument?: InstrumentId;
}) {
  const { t } = useTranslations();
  const { date: formatDate } = useFormatters();
  const [tab, setTab] = useState<InstrumentId>(instrument ?? "PHQ9");
  // Which flagged row's crisis card is currently expanded (re-surfaced).
  const [openCrisisRowId, setOpenCrisisRowId] = useState<string | null>(null);

  const pinned = instrument != null;
  // When pinned, the tab is forced to the host instrument so re-opening the
  // detail for the other instrument never paints a stale series.
  const activeTab = pinned ? instrument : tab;

  const forTab = useMemo(
    () =>
      rows
        .filter((r) => r.instrument === activeTab)
        .sort(
          (a, b) =>
            new Date(b.takenAt).getTime() - new Date(a.takenAt).getTime(),
        ),
    [rows, activeTab],
  );

  // Pinned: emptiness is per-instrument (the host opened THIS instrument's
  // detail). Combined: emptiness spans both instruments, as before.
  const isEmpty = pinned ? forTab.length === 0 : rows.length === 0;

  const body = (
    <>
      {isEmpty ? (
        <EmptyState
          icon={<Activity className="size-6" />}
          title={t("mentalHealth.history.title")}
          description={t("mentalHealth.history.empty")}
        />
      ) : (
        <>
          {/* PHQ-9 / GAD-7 toggle — the two ranges + band sets can't share an
              axis, so the chart + list paint one instrument at a time. Hidden
              when pinned: the host already chose the instrument. */}
          {!pinned && (
            <div
              className="flex gap-1"
              role="tablist"
              aria-label={t("mentalHealth.history.chartTitle")}
            >
              {(["PHQ9", "GAD7"] as InstrumentId[]).map((id) => (
                <Button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === id}
                  size="sm"
                  variant={activeTab === id ? "secondary" : "ghost"}
                  className="h-8 px-3 text-xs"
                  onClick={() => {
                    setTab(id);
                    setOpenCrisisRowId(null);
                  }}
                >
                  {t(`mentalHealth.history.tab.${lower(id)}`)}
                </Button>
              ))}
            </div>
          )}

          <AssessmentHistoryChart instrument={activeTab} rows={forTab} />

          {forTab.length === 0 ? (
            <p className="text-muted-foreground py-4 text-center text-sm">
              {t("mentalHealth.history.empty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5" data-slot="history-list">
              {forTab.map((row) => {
                const flagged = row.item9Flagged;
                const open = openCrisisRowId === row.id;
                return (
                  <li key={row.id} className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-muted-foreground">
                        {formatDate(row.takenAt)}
                      </span>
                      <div className="flex items-center gap-2">
                        {flagged && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-auto p-0"
                            aria-expanded={open}
                            onClick={() =>
                              setOpenCrisisRowId(open ? null : row.id)
                            }
                            data-slot="history-flagged-marker"
                          >
                            <Badge variant="outline">
                              {t("mentalHealth.history.flaggedBadge")}
                            </Badge>
                          </Button>
                        )}
                        <Badge variant="secondary">
                          {t(
                            `mentalHealth.band.${row.instrument}.${row.severityBand}`,
                          )}
                        </Badge>
                        <span className="font-medium tabular-nums">
                          {row.totalScore}
                        </span>
                      </div>
                    </div>
                    {flagged && open && (
                      <CrisisCard crisis={crisisFromRow(row)} />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </>
  );

  // Pinned: render bare (the host sheet owns the chrome + title). Combined:
  // the landing's titled history card, unchanged.
  if (pinned) {
    return (
      <div
        data-slot="mental-health-history"
        data-pinned={instrument}
        className="flex flex-col gap-4"
      >
        {body}
      </div>
    );
  }

  return (
    <Card data-slot="mental-health-history">
      <CardHeader>
        <CardTitle className="text-base">
          {t("mentalHealth.history.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{body}</CardContent>
    </Card>
  );
}
