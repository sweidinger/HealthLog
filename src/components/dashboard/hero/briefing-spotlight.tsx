"use client";

/**
 * v1.18.11 — dashboard briefing spotlight.
 *
 * The daily briefing previously surfaced on the dashboard ONLY as the
 * hero's rung-8 verdict — a single sentence that almost always lost the
 * verdict slot to a routine state (an upcoming dose, a weight drift, the
 * all-quiet fallback). A fresh, model-authored briefing was effectively
 * invisible above the fold.
 *
 * This strip raises the briefing's prominence WITHOUT touching its
 * content or generation: it lifts the briefing's own present-focused
 * "Signals of the day" (falling back to the longer-horizon key findings)
 * straight onto the dashboard hero, so the freshest read is always one
 * glance away. The verdict ladder is unchanged — a real BP crisis still
 * leads the verdict line; this band sits below it.
 *
 * Design contract:
 *   - reuses the established tone-bar + metric-icon row language from the
 *     `/insights` daily-briefing card so the two surfaces read identically;
 *   - self-gating — renders nothing unless a FRESH briefing (`ready`, not
 *     stale) carries at least one signal or finding, so a missing /
 *     stale / disabled briefing never leaves an empty band;
 *   - rows are tappable, routing to `/insights` for the full briefing;
 *   - plain text children only (no HTML / markdown) per the repo-wide
 *     no-markdown-renderer rule; headlines pass through `stripChartTokens`
 *     to defend against a stray chart token leaking into the prose.
 *
 * Pure presentational: the caller resolves the briefing from the
 * server-authoritative snapshot and passes the already-validated payload.
 */
import Link from "next/link";
import {
  Activity,
  Flame,
  Footprints,
  Heart,
  HeartPulse,
  Mountain,
  Moon,
  Pill,
  Route,
  Scale,
  Smile,
  Sparkles,
  Thermometer,
  Wind,
  Zap,
} from "lucide-react";
import { ListRow } from "@/components/ui/list-row";
import { useTranslations } from "@/lib/i18n/context";
import { stripChartTokens } from "@/lib/insights/chart-tokens";
import { cn } from "@/lib/utils";
import type { DailyBriefing, DailyBriefingKeyFinding } from "@/lib/ai/schema";

/**
 * Max rows the spotlight surfaces. The briefing caps `signalsOfDay` at 3
 * and `keyFindings` at 5; the dashboard strip stays a glance, so it shows
 * at most the top 3 — the user opens `/insights` for the full list.
 */
const MAX_SPOTLIGHT_ROWS = 3;

const METRIC_ICON: Record<
  DailyBriefingKeyFinding["sourceMetric"],
  React.ComponentType<{ className?: string }>
> = {
  bp: Heart,
  weight: Scale,
  pulse: Activity,
  mood: Smile,
  compliance: Pill,
  hrv: Wind,
  sleep: Moon,
  resting_hr: HeartPulse,
  steps: Footprints,
  active_energy: Flame,
  flights: Mountain,
  distance: Route,
  vo2_max: Zap,
  body_temp: Thermometer,
  glp1_plateau: Pill,
  readiness: Sparkles,
  recovery: HeartPulse,
};

const TONE_BAR_CLASSNAME: Record<DailyBriefingKeyFinding["tone"], string> = {
  good: "bg-success",
  watch: "bg-warning",
  info: "bg-info",
};

const TONE_TEXT_CLASSNAME: Record<DailyBriefingKeyFinding["tone"], string> = {
  good: "text-success",
  watch: "text-warning",
  info: "text-info",
};

/** One spotlight row, normalised from a signal or a key finding. */
interface SpotlightRow {
  sourceMetric: DailyBriefingKeyFinding["sourceMetric"];
  tone: DailyBriefingKeyFinding["tone"];
  headline: string;
  delta: string | null;
}

/**
 * Choose the rows to spotlight. Prefers the present-focused
 * `signalsOfDay` (the rebuilt briefing's lead); falls back to the
 * longer-horizon `keyFindings` when no signals were generated. Returns an
 * empty array when neither carries content (the caller then renders
 * nothing).
 */
function selectSpotlightRows(briefing: DailyBriefing): SpotlightRow[] {
  const signals = briefing.signalsOfDay ?? [];
  if (signals.length > 0) {
    return signals.slice(0, MAX_SPOTLIGHT_ROWS).map((s) => ({
      sourceMetric: s.sourceMetric,
      tone: s.tone,
      headline: s.headline,
      delta: s.delta,
    }));
  }
  return briefing.keyFindings.slice(0, MAX_SPOTLIGHT_ROWS).map((f) => ({
    sourceMetric: f.sourceMetric,
    tone: f.tone,
    headline: f.headline,
    delta: f.delta,
  }));
}

export function BriefingSpotlight({
  briefing,
  briefingState,
  briefingStale,
}: {
  briefing: DailyBriefing | null;
  briefingState: string;
  briefingStale: boolean;
}) {
  const { t } = useTranslations();

  // Fresh-only gate: a ready, non-stale briefing with at least one row.
  // A stale / preparing / disabled briefing falls through to nothing so
  // the band never sits empty or narrates a days-old read as current.
  if (briefingState !== "ready" || briefingStale || briefing === null) {
    return null;
  }
  const rows = selectSpotlightRows(briefing);
  if (rows.length === 0) return null;

  return (
    <div data-slot="dashboard-briefing-spotlight" className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
          {t("dashboard.hero.briefing.title")}
        </p>
        <Link
          href="/insights"
          data-slot="dashboard-briefing-spotlight-link"
          className="text-muted-foreground hover:text-foreground text-[11px] underline underline-offset-2"
        >
          {t("dashboard.hero.briefing.viewAll")}
        </Link>
      </div>
      <div className="space-y-2">
        {rows.map((row, index) => {
          const Icon = METRIC_ICON[row.sourceMetric];
          return (
            <ListRow
              key={`${row.sourceMetric}-${index}`}
              asChild
              data-slot="dashboard-briefing-spotlight-row"
              data-metric={row.sourceMetric}
              className={cn(
                "border-border/60 bg-card/40 relative flex items-start gap-3",
                "hover:bg-accent/40 transition-colors",
                "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
              )}
            >
              <Link href="/insights">
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute top-3 bottom-3 left-0 w-[3px] rounded-r",
                    TONE_BAR_CLASSNAME[row.tone],
                  )}
                />
                <Icon
                  className={cn(
                    "mt-0.5 h-4 w-4 shrink-0",
                    TONE_TEXT_CLASSNAME[row.tone],
                  )}
                  aria-hidden="true"
                />
                <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
                  <p className="text-foreground text-sm leading-snug font-medium">
                    {stripChartTokens(row.headline)}
                  </p>
                  {row.delta ? (
                    <span
                      data-slot="dashboard-briefing-spotlight-delta"
                      className={cn(
                        "shrink-0 text-xs font-semibold tabular-nums",
                        TONE_TEXT_CLASSNAME[row.tone],
                      )}
                    >
                      {row.delta}
                    </span>
                  ) : null}
                </div>
              </Link>
            </ListRow>
          );
        })}
      </div>
    </div>
  );
}
