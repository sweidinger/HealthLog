"use client";

/**
 * v1.28.20 — compact GLP-1 estimated active-substance curve for the Insights
 * medication surface. Additive to the medication detail page's Injektion and
 * Wirkung tabs: the same self-contained `DrugLevelChart` (modelled
 * one-compartment level from the user's logged intakes + dose changes),
 * surfaced where the compliance overview already lives.
 *
 * Gating: reads `GET /api/insights/glp1-timeline` — the server-authoritative
 * GLP-1 signal. When `hasGlp1` is false the block renders nothing. The set of
 * GLP-1 medication names comes from the timeline's entries (every entry is
 * from a `treatmentClass === "GLP1"` medication), and the passed medication
 * list is filtered to that set so non-GLP-1 medications never render a curve.
 *
 * The chart carries its own `MedicationDetailSection` card chrome + estimate
 * disclaimer, so it reads as one system with the surrounding Insights cards
 * without a second computation. Recharts loads through `next/dynamic`
 * (client-only) to stay out of the page's initial bundle.
 */
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";

import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { Glp1PlateauNote } from "@/components/insights/glp1-plateau-note";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";

const DrugLevelChart = dynamic(
  () =>
    import("@/components/charts/chart-runtime").then((mod) => ({
      default: mod.DrugLevelChart,
    })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);

interface Glp1TimelineResponse {
  hasGlp1: boolean;
  entries: { medicationName?: string }[];
}

export function Glp1SubstanceCurveSummary({
  medications,
}: {
  medications: { id: string; name: string; dose: string }[];
}) {
  const { data } = useQuery({
    queryKey: queryKeys.insightsGlp1Timeline(200),
    queryFn: () =>
      apiGet<Glp1TimelineResponse>("/api/insights/glp1-timeline?limit=200"),
    staleTime: 60_000,
  });

  if (!data?.hasGlp1) return null;

  // Every timeline entry is from a GLP-1 medication (server filters on
  // `treatmentClass: "GLP1"`). Medication names match the comprehensive
  // list exactly — both derive from `medication.name` server-side.
  const glp1Names = new Set(
    data.entries
      .map((e) => e.medicationName)
      .filter((n): n is string => typeof n === "string" && n.length > 0),
  );

  const glp1Meds = medications.filter((m) => glp1Names.has(m.name));
  if (glp1Meds.length === 0) return null;

  const showNameLabel = glp1Meds.length > 1;

  return (
    <div className="space-y-4" data-slot="insights-glp1-substance-curve">
      {glp1Meds.map((med) => (
        <div key={med.id} className="space-y-2">
          {showNameLabel ? (
            <p className="text-muted-foreground px-1 text-xs font-medium">
              {med.name}
            </p>
          ) : null}
          <DrugLevelChart
            medication={{ id: med.id, name: med.name, dose: med.dose }}
          />
        </div>
      ))}
      {/* v1.28.21 — weight-plateau note (association only), below the
          curve(s). Self-gating: renders nothing unless the server-side
          detector reports a plateau on the current dose. */}
      <Glp1PlateauNote />
    </div>
  );
}
