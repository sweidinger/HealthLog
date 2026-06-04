"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { ScoreRing } from "./score-ring";
import type { DerivedBatchRead } from "./use-derived-metric";
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
 * render (never an apologetic empty ring). All five composites/scores now
 * route to a `ScoreAnatomyView` detail page (`/insights/scores/<slug>`) so
 * every ring carries its inputs + method + cited standard one tap away — the
 * three persisted scores (Recovery, Stress, Strain) are no longer read-only
 * dead-ends. The band word renders under each ring so a less-technical user
 * reads "low 62", not a bare reddish 62.
 *
 * Every ring reads from the ONE batched `/api/insights/derived/batch`
 * request the parent dashboard owns (passed in via `read`) — no per-ring
 * request, no cold-mount fan-out. The reads are already-computed
 * rollup/persisted values; nothing warms on visit.
 */

interface ScoreStripProps {
  /** The batched-read selector from the parent dashboard's one query. */
  read: DerivedBatchRead;
  isLoading: boolean;
  className?: string;
}

/** A score ring wrapped in a link to its anatomy detail page. */
function RingTile({
  score,
  band,
  label,
  bandWord,
  href,
  metricSlot,
}: {
  score: number;
  band: ScoreBand;
  label: string;
  bandWord: string;
  href: string;
  metricSlot: string;
}) {
  return (
    <Link
      href={href}
      data-slot="wellness-score-tile"
      data-metric={metricSlot}
      className="bg-card border-border hover:border-foreground/20 focus-visible:ring-ring flex items-center justify-center rounded-xl border p-4 transition-colors focus-visible:ring-2 focus-visible:outline-none"
    >
      <div className="flex min-w-0 flex-col items-center gap-1.5">
        {/* The metric title rides an HTML caption below the ring, not the
            in-SVG `label` slot: a long localised title ("Schlaf-Score",
            "Bereitschaft") overflowed the small ring's centred SVG text and
            the recharts `overflow:hidden` clipped its leading glyph. As HTML
            it wraps within the tile and never truncates. The ring keeps just
            the number centred. */}
        <ScoreRing score={score} band={band} size="sm" />
        <span
          data-slot="wellness-score-label"
          className="text-foreground max-w-full text-center text-xs font-medium text-balance"
        >
          {label}
        </span>
        <span
          data-slot="wellness-score-band-word"
          className="text-muted-foreground text-center text-xs"
        >
          {bandWord}
        </span>
      </div>
    </Link>
  );
}

export function WellnessScores({ read, isLoading, className }: ScoreStripProps) {
  const { t } = useTranslations();

  const readiness = read<ReadinessValue>({ metric: "READINESS" });
  const sleep = read<SleepScoreValue>({ metric: "SLEEP_SCORE" });
  const recovery = read<WellnessScoreValue>({ metric: "RECOVERY_SCORE" });
  const stress = read<WellnessScoreValue>({ metric: "STRESS_SCORE" });
  const strain = read<WellnessScoreValue>({ metric: "STRAIN_SCORE" });

  const bandWord = (band: ScoreBand) =>
    t(`insights.derived.scoreRing.band.${band}`);

  const tiles: React.ReactNode[] = [];

  if (!isLoading && readiness?.status === "ok" && readiness.value) {
    tiles.push(
      <RingTile
        key="READINESS"
        score={readiness.value.score}
        band={readiness.value.band}
        label={t("insights.derived.composite.READINESS.title")}
        bandWord={bandWord(readiness.value.band)}
        href="/insights/scores/readiness"
        metricSlot="READINESS"
      />,
    );
  }
  if (!isLoading && recovery?.status === "ok" && recovery.value) {
    tiles.push(
      <RingTile
        key="RECOVERY_SCORE"
        score={recovery.value.score}
        band={recovery.value.band}
        label={t("insights.derived.scores.recovery")}
        bandWord={bandWord(recovery.value.band)}
        href="/insights/scores/recovery"
        metricSlot="RECOVERY_SCORE"
      />,
    );
  }
  if (!isLoading && sleep?.status === "ok" && sleep.value) {
    tiles.push(
      <RingTile
        key="SLEEP_SCORE"
        score={sleep.value.score}
        band={sleep.value.band}
        label={t("insights.derived.composite.SLEEP_SCORE.title")}
        bandWord={bandWord(sleep.value.band)}
        href="/insights/scores/sleep"
        metricSlot="SLEEP_SCORE"
      />,
    );
  }
  if (!isLoading && stress?.status === "ok" && stress.value) {
    tiles.push(
      <RingTile
        key="STRESS_SCORE"
        score={stress.value.score}
        band={stress.value.band}
        label={t("insights.derived.scores.stress")}
        bandWord={bandWord(stress.value.band)}
        href="/insights/scores/stress"
        metricSlot="STRESS_SCORE"
      />,
    );
  }
  if (!isLoading && strain?.status === "ok" && strain.value) {
    tiles.push(
      <RingTile
        key="STRAIN_SCORE"
        score={strain.value.score}
        band={strain.value.band}
        label={t("insights.derived.scores.strain")}
        bandWord={bandWord(strain.value.band)}
        href="/insights/scores/strain"
        metricSlot="STRAIN_SCORE"
      />,
    );
  }

  // Whole strip un-mounts when no score has data — never an empty section.
  if (tiles.length === 0) return null;

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
        {tiles}
      </div>
    </section>
  );
}
