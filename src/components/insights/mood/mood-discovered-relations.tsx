"use client";

import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.11.5 (F3) — FDR-controlled discovered mood relations.
 *
 * Surfaces the slice of the all-pairs correlation-discovery engine
 * (`/api/insights/correlations`) that involves mood — both
 * "behaviour today → next-day mood" (mood promoted to an OUTCOME channel in
 * this release) and "mood today → next-day outcome". Only pairs that survive
 * the Benjamini-Hochberg false-discovery correction the engine already
 * applies are returned, so this is the statistically-defensible complement
 * to the descriptive influence / better-days surfaces.
 *
 * Renders nothing when the operator has disabled the correlations surface
 * (the route 403s — we degrade silently), while loading, or when no mood
 * pair cleared the bar. Observational only; the standing disclaimer rides
 * the card.
 */

interface DiscoveredCorrelation {
  behaviour: string;
  outcome: string;
  n: number;
  r: number;
  pValue: number;
  qValue: number;
  interpretation: string;
  lagDays: number;
}

interface CorrelationDiscoveryResponse {
  discovered: DiscoveredCorrelation[];
  pairsTested: number;
  fdrQ: number;
  minPairs: number;
}

/** Map a discovery channel key to its localized measurement-type label. */
const CHANNEL_LABEL_KEY: Record<string, string> = {
  TIME_IN_DAYLIGHT: "measurements.typeTimeInDaylight",
  BLOOD_GLUCOSE: "measurements.typeBloodGlucose",
  BLOOD_PRESSURE_SYS: "measurements.typeBloodPressure",
  ACTIVITY_STEPS: "measurements.typeSteps",
  SLEEP_DURATION: "measurements.typeSleep",
  HEART_RATE_VARIABILITY: "measurements.typeHeartRateVariability",
  RESTING_HEART_RATE: "measurements.typeRestingHeartRate",
  WEIGHT: "measurements.typeWeight",
};

export function MoodDiscoveredRelations() {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();

  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.insightsCorrelations(),
    queryFn: async () => {
      const res = await fetch("/api/insights/correlations");
      // 403 = operator disabled the surface; any non-OK degrades to nothing.
      if (!res.ok) throw new Error("unavailable");
      const json = await res.json();
      return json.data as CorrelationDiscoveryResponse;
    },
    enabled: isAuthenticated,
    staleTime: 60_000,
    // The surface is optional — don't retry a deliberate 403 into noise.
    retry: false,
  });

  if (isLoading || isError || !data) return null;

  const moodPairs = data.discovered.filter(
    (pair) => pair.behaviour === "MOOD" || pair.outcome === "MOOD",
  );
  if (moodPairs.length === 0) return null;

  return (
    <div className="space-y-2" data-slot="mood-discovered-relations">
      <h3 className="text-base font-semibold">
        {t("insights.mood.discovery.title")}
      </h3>
      <p className="text-muted-foreground text-sm">
        {t("insights.mood.discovery.description")}
      </p>
      <ul className="divide-border divide-y">
        {moodPairs.map((pair) => {
          const moodIsOutcome = pair.outcome === "MOOD";
          const channelKey = moodIsOutcome ? pair.behaviour : pair.outcome;
          const factorLabel = t(CHANNEL_LABEL_KEY[channelKey] ?? channelKey);
          const up = pair.r >= 0;
          const sentenceKey = moodIsOutcome
            ? up
              ? "insights.mood.discovery.moodUp"
              : "insights.mood.discovery.moodDown"
            : up
              ? "insights.mood.discovery.outcomeUp"
              : "insights.mood.discovery.outcomeDown";
          return (
            <li
              key={`${pair.behaviour}->${pair.outcome}`}
              className="flex flex-col gap-1 py-2 text-sm"
              data-slot="mood-discovered-pair"
              data-mood-role={moodIsOutcome ? "outcome" : "behaviour"}
              data-direction={up ? "up" : "down"}
            >
              <span className="text-foreground">
                {t(sentenceKey, { factor: factorLabel })}
              </span>
              <span className="text-muted-foreground text-[11px] tabular-nums">
                {t("insights.mood.discovery.stat", {
                  n: pair.n,
                  r: pair.r.toFixed(2),
                  q: pair.qValue.toFixed(3),
                })}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="text-muted-foreground text-[11px]">
        {t("insights.mood.discovery.footer", {
          tested: data.pairsTested,
        })}
      </p>
      <p className="text-muted-foreground text-[11px]">
        {t("insights.mood.discovery.disclaimer")}
      </p>
    </div>
  );
}
