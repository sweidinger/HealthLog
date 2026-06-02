"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { ScoreRing } from "./score-ring";
import { useDerivedMetric } from "./use-derived-metric";
import type { ScoreBand } from "./band-tokens";
// Type-only — the compute payloads never drag the server graph into the bundle.
import type { ReadinessValue } from "@/lib/insights/derived/readiness";
import type { SleepScoreValue } from "@/lib/insights/derived/sleep-score";
import type { WellnessScoreValue } from "@/lib/insights/derived/wellness-scores";

/**
 * v1.10.0 — the wellness-scores strip.
 *
 * A row of score rings for the composite + persisted wellness scores, each
 * data-availability-gated: a score the user has no data for simply does not
 * render (never an apologetic empty ring). The two composites with a detail
 * surface (Readiness, Sleep) are tappable and route to their existing
 * `ScoreAnatomyView` page (`/insights/scores/<slug>`); the persisted nightly
 * scores (Recovery, Stress, Strain) render as read-only rings.
 *
 * Every ring reads the SAME `/api/insights/derived` route through the one
 * `useDerivedMetric` hook — no per-screen recompute, no warm-on-mount fan-out
 * (the reads are already-computed rollup/persisted values).
 */

interface ScoreTileProps {
  enabled: boolean;
}

/** A score ring optionally wrapped in a link to its anatomy detail page. */
function RingTile({
  score,
  band,
  label,
  href,
  metricSlot,
}: {
  score: number;
  band: ScoreBand;
  label: string;
  href?: string;
  metricSlot: string;
}) {
  const ring = (
    <div className="flex flex-col items-center gap-2">
      <ScoreRing score={score} band={band} size="sm" label={label} />
    </div>
  );
  if (href) {
    return (
      <Link
        href={href}
        data-slot="wellness-score-tile"
        data-metric={metricSlot}
        className="bg-card border-border hover:border-foreground/20 focus-visible:ring-ring flex items-center justify-center rounded-xl border p-4 transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        {ring}
      </Link>
    );
  }
  return (
    <div
      data-slot="wellness-score-tile"
      data-metric={metricSlot}
      className="bg-card border-border flex items-center justify-center rounded-xl border p-4"
    >
      {ring}
    </div>
  );
}

function ReadinessTile({ enabled }: ScoreTileProps) {
  const { t } = useTranslations();
  const { data, isLoading } = useDerivedMetric<ReadinessValue>("READINESS", {
    enabled,
  });
  if (isLoading || !data || data.status !== "ok" || !data.value) return null;
  return (
    <RingTile
      score={data.value.score}
      band={data.value.band}
      label={t("insights.derived.composite.READINESS.title")}
      href="/insights/scores/readiness"
      metricSlot="READINESS"
    />
  );
}

function SleepTile({ enabled }: ScoreTileProps) {
  const { t } = useTranslations();
  const { data, isLoading } = useDerivedMetric<SleepScoreValue>("SLEEP_SCORE", {
    enabled,
  });
  if (isLoading || !data || data.status !== "ok" || !data.value) return null;
  return (
    <RingTile
      score={data.value.score}
      band={data.value.band}
      label={t("insights.derived.composite.SLEEP_SCORE.title")}
      href="/insights/scores/sleep"
      metricSlot="SLEEP_SCORE"
    />
  );
}

function PersistedScoreTile({
  metric,
  labelKey,
  enabled,
}: {
  metric: "RECOVERY_SCORE" | "STRESS_SCORE" | "STRAIN_SCORE";
  labelKey: string;
  enabled: boolean;
}) {
  const { t } = useTranslations();
  const { data, isLoading } = useDerivedMetric<WellnessScoreValue>(metric, {
    enabled,
  });
  if (isLoading || !data || data.status !== "ok" || !data.value) return null;
  return (
    <RingTile
      score={data.value.score}
      band={data.value.band}
      label={t(labelKey)}
      metricSlot={metric}
    />
  );
}

export function WellnessScores({
  enabled = true,
  className,
}: {
  enabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslations();
  return (
    <section
      data-slot="wellness-scores"
      aria-label={t("insights.derived.scores.sectionTitle")}
      className={cn("space-y-3", className)}
    >
      <h2 className="text-foreground text-sm font-semibold tracking-tight">
        {t("insights.derived.scores.sectionTitle")}
      </h2>
      <div
        data-slot="wellness-scores-grid"
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
      >
        <ReadinessTile enabled={enabled} />
        <PersistedScoreTile
          metric="RECOVERY_SCORE"
          labelKey="insights.derived.scores.recovery"
          enabled={enabled}
        />
        <SleepTile enabled={enabled} />
        <PersistedScoreTile
          metric="STRESS_SCORE"
          labelKey="insights.derived.scores.stress"
          enabled={enabled}
        />
        <PersistedScoreTile
          metric="STRAIN_SCORE"
          labelKey="insights.derived.scores.strain"
          enabled={enabled}
        />
      </div>
    </section>
  );
}
