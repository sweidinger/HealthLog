"use client";

import type { ComponentType } from "react";
import Link from "next/link";
import { Activity, Flame, Gauge, HeartPulse, Moon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { TileHeader } from "@/components/insights/tile-header";
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
  icon,
}: {
  score: number;
  band: ScoreBand;
  label: string;
  bandWord: string;
  href: string;
  metricSlot: string;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <Link
      href={href}
      data-slot="wellness-score-tile"
      data-metric={metricSlot}
      className="bg-card border-border hover:border-foreground/20 focus-visible:ring-ring flex flex-col gap-3 rounded-xl border p-4 transition-colors focus-visible:ring-2 focus-visible:outline-none"
    >
      {/* v1.12.6 — every tile leads with the canonical icon + heading
          (foreground colour, matching the Einschätzung reference) so the
          wellness strip reads as the same card language as the rest of
          Insights. The metric name no longer rides an under-ring caption. */}
      <TileHeader icon={icon} title={label} titleClassName="truncate" />
      <div className="flex flex-col items-center gap-1.5">
        {/* The ring keeps just the number centred; the metric name lives in
            the TileHeader above (a long localised title would overflow the
            small ring's centred SVG text and clip under recharts'
            `overflow:hidden`). */}
        <ScoreRing score={score} band={band} size="sm" />
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
        icon={Gauge}
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
        icon={HeartPulse}
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
        icon={Moon}
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
        icon={Activity}
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
        icon={Flame}
      />,
    );
  }

  // Whole strip un-mounts when no score has data — never an empty section.
  if (tiles.length === 0) return null;

  // v1.12.4 — the strip used a fixed `lg:grid-cols-5`, so the common case of
  // four active scores left one empty cell on the right and read as "a tile
  // is missing". Track the desktop column count to the actual number of tiles
  // (capped at 5) so the row always fills its full width. The static class
  // map keeps every variant in the Tailwind output (no purge surprise).
  const LG_COLS: Record<number, string> = {
    1: "lg:grid-cols-1",
    2: "lg:grid-cols-2",
    3: "lg:grid-cols-3",
    4: "lg:grid-cols-4",
    5: "lg:grid-cols-5",
  };
  const lgCols = LG_COLS[Math.min(tiles.length, 5)] ?? "lg:grid-cols-5";

  return (
    <section
      data-slot="wellness-scores"
      aria-label={t("insights.derived.scores.sectionTitle")}
      className={cn("space-y-3", className)}
    >
      <TileHeader
        icon={Activity}
        title={t("insights.derived.scores.sectionTitle")}
      />
      <div
        data-slot="wellness-scores-grid"
        className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3", lgCols)}
      >
        {tiles}
      </div>
    </section>
  );
}
