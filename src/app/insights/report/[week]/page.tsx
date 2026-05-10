"use client";

import { use } from "react";
import { useSearchParams, notFound } from "next/navigation";

import { WeeklyReportView } from "@/components/insights/weekly-report-view";
import { parseWeekISO } from "@/lib/insights/week-iso";

/**
 * v1.4.20 phase B4 — Newsletter-style printable weekly report at
 * `/insights/report/[week]` (e.g. `/insights/report/2026-W19`).
 *
 * The page is a thin client wrapper around `<WeeklyReportView>`:
 *   - `[week]` is parsed via `parseWeekISO`; malformed input → 404 so
 *     the route never rends a half-broken report.
 *   - `?print=1` triggers an automatic `window.print()` after first
 *     paint; this is the deep-link target for the hero strip's banner-
 *     card "Export PDF" action.
 *
 * The view itself reads the cached AI advisor payload and shows an
 * empty-state with a Generate CTA when no report covers `[week]`.
 *
 * Print stylesheet lives on Tailwind `print:` variants directly inside
 * the component — no separate CSS file needed for the v1.4.20 surface.
 */
export default function WeeklyReportPage({
  params,
}: {
  params: Promise<{ week: string }>;
}) {
  const { week } = use(params);
  const parsed = parseWeekISO(week);
  if (!parsed) {
    notFound();
  }
  const searchParams = useSearchParams();
  const autoPrint = searchParams?.get("print") === "1";

  return <WeeklyReportView weekISO={parsed.weekISO} autoPrint={autoPrint} />;
}
