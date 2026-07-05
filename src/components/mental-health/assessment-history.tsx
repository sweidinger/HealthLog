"use client";

/**
 * v1.25.3 — the history card: a dated list with severity badges.
 *
 * v1.27.6 — the trend CHART is gone from this surface. A rising score curve
 * on the check-in page itself reads as a verdict at the exact moment someone
 * is taking stock of how they feel; the page stays a calm list of past
 * check-ins. The score trend still exists — the totals ride PHQ9_SCORE /
 * GAD7_SCORE measurement rows, so Insights / Measurements carry the curve
 * for whoever seeks it out.
 *
 * PHQ-9 / GAD-7 toggle: the two instruments have different score ranges +
 * bands, so the list shows one at a time.
 *
 * CRISIS-SAFETY: a flagged PHQ-9 row carries a discreet "support shown" marker;
 * tapping it re-surfaces the STATIC crisis-resource card derived from the row's
 * stored locale (`crisisResourcesForLocale`) — it NEVER decrypts or reveals the
 * item-9 answer, and surfacing it triggers no third-party alert. No new data
 * leaves the safety boundary.
 */
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { crisisResourcesForLocale } from "@/lib/mental-health/crisis-resources";
import { Activity } from "lucide-react";

import { CrisisCard } from "./crisis-card";
import type { AssessmentRow, CrisisSet, InstrumentId } from "./types";

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

export function AssessmentHistory({ rows }: { rows: AssessmentRow[] }) {
  const { t } = useTranslations();
  const { date: formatDate } = useFormatters();
  const [tab, setTab] = useState<InstrumentId>("PHQ9");
  // Which flagged row's crisis card is currently expanded (re-surfaced).
  const [openCrisisRowId, setOpenCrisisRowId] = useState<string | null>(null);

  const forTab = useMemo(
    () =>
      rows
        .filter((r) => r.instrument === tab)
        .sort(
          (a, b) =>
            new Date(b.takenAt).getTime() - new Date(a.takenAt).getTime(),
        ),
    [rows, tab],
  );

  const isEmpty = rows.length === 0;

  return (
    <Card data-slot="mental-health-history">
      <CardHeader>
        <CardTitle className="text-base">
          {t("mentalHealth.history.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isEmpty ? (
          <EmptyState
            icon={<Activity className="size-6" />}
            title={t("mentalHealth.history.title")}
            description={t("mentalHealth.history.empty")}
          />
        ) : (
          <>
            {/* PHQ-9 / GAD-7 toggle — the two ranges + band sets differ, so
                the list shows one instrument at a time. */}
            <div
              className="flex gap-1"
              role="tablist"
              aria-label={t("mentalHealth.history.title")}
            >
              {(["PHQ9", "GAD7"] as InstrumentId[]).map((id) => (
                <Button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  size="sm"
                  variant={tab === id ? "secondary" : "ghost"}
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
      </CardContent>
    </Card>
  );
}
