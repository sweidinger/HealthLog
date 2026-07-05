"use client";

import type { InsightRecommendation } from "@/lib/ai/types";
import { RecommendationCard } from "./recommendation-card";

/**
 * v1.4.16 phase B1b — Apple-Health-style recommendations grid.
 *
 * Pure layout shell around `<RecommendationCard>`:
 *   - 1-col mobile, 2-col desktop (no `xl:grid-cols-3` — recs benefit
 *     from breathing room on a wide viewport, and the card's expanded
 *     rationale + mini-chart pushes the natural max-content well past
 *     the 3-col break)
 *   - severity-priority ordering (urgent → important → suggestion → info)
 *   - severity-coloured left border per card via a thin shell `<div>`
 *     wrapper so the underlying `<RecommendationCard>` (B5c/d/e shape)
 *     doesn't need its own border refactor
 *   - staggered fade-in via inline animationDelay so the cards sweep in
 *     left-to-right, top-to-bottom on first render
 *   - hover-lift on desktop (`md:hover:-translate-y-0.5`,
 *     `md:hover:shadow-lg`)
 *
 * The grid is unmounted entirely when `recs` is empty so the parent
 * doesn't have to gate every call site.
 */

interface RecommendationsGridProps {
  recs: InsightRecommendation[];
}

const SEVERITY_RANK: Record<string, number> = {
  urgent: 0,
  important: 1,
  suggestion: 2,
  info: 3,
};
const SEVERITY_RANK_FALLBACK = 4;

/**
 * Stable sort by severity priority. Plain-string recs and recs missing
 * a severity field fall to the bottom but keep their relative order
 * (the wrapping `<RecommendationCard>` still renders them — just under
 * the actionable severities).
 */
export function sortRecommendationsBySeverity(
  recs: InsightRecommendation[],
): InsightRecommendation[] {
  return recs
    .map((rec, index) => {
      const severity = typeof rec === "string" ? null : rec.severity;
      const rank =
        severity && severity in SEVERITY_RANK
          ? SEVERITY_RANK[severity]
          : SEVERITY_RANK_FALLBACK;
      return { rec, index, rank };
    })
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.index - b.index;
    })
    .map(({ rec }) => rec);
}

const SEVERITY_BORDER_CLASSES: Record<string, string> = {
  urgent: "border-l-destructive/70",
  important: "border-l-warning/70",
  suggestion: "border-l-primary/70",
  info: "border-l-info/70",
};

const SEVERITY_BORDER_FALLBACK = "border-l-border";

/**
 * Stagger interval, in ms. Brief asks for 100ms — chosen so a 4-card
 * grid finishes the cascade in ~400ms (matches the existing
 * `animate-insight-in` 400ms keyframe, so by the time the last card
 * starts animating, the first has finished). Globally muted by
 * `prefers-reduced-motion: reduce` via the existing media query in
 * `globals.css`.
 */
const STAGGER_INTERVAL_MS = 100;

export function RecommendationsGrid({ recs }: RecommendationsGridProps) {
  if (recs.length === 0) return null;
  const ordered = sortRecommendationsBySeverity(recs);
  return (
    <div
      data-slot="rec-grid"
      role="list"
      className="grid grid-cols-1 gap-3 lg:grid-cols-2"
    >
      {ordered.map((rec, index) => {
        const severity = typeof rec === "string" ? null : rec.severity;
        const borderClass =
          (severity && SEVERITY_BORDER_CLASSES[severity]) ||
          SEVERITY_BORDER_FALLBACK;
        return (
          <div
            key={
              typeof rec === "string" ? `${index}-${rec}` : (rec.id ?? index)
            }
            data-stagger-index={index}
            role="listitem"
            className={`animate-insight-in transition-all md:hover:-translate-y-0.5 md:hover:shadow-lg ${borderClass} rounded-lg border-l-2 motion-reduce:transition-none motion-reduce:hover:translate-y-0`}
            style={{ animationDelay: `${index * STAGGER_INTERVAL_MS}ms` }}
          >
            <RecommendationCard rec={rec} index={index} />
          </div>
        );
      })}
    </div>
  );
}
