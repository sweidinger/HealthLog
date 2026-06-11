"use client";

import { useTranslations } from "@/lib/i18n/context";
import { moodTagIcon } from "@/components/mood/mood-tag-icons";

/**
 * v1.8.5 — structured-tag breakdown.
 *
 * Ranked icon-bearing rows over the taxonomy tags the user picked,
 * grouped under their category, with the per-tag average mood ("lift")
 * as a coloured score. Distinct from the flat free-text breakdown:
 * structured tags carry icons + categories from the curated catalog.
 */

export interface MoodStructuredTagRow {
  key: string;
  categoryKey: string;
  labelKey: string;
  icon: string | null;
  count: number;
  avgScore: number;
}

function colorForScore(score: number): string {
  if (score < 2) return "var(--dracula-red)";
  if (score < 3) return "var(--dracula-orange)";
  if (score < 3.5) return "var(--dracula-yellow)";
  return "var(--dracula-green)";
}

export function MoodStructuredTagBreakdown({
  tags,
}: {
  tags: MoodStructuredTagRow[];
}) {
  const { t } = useTranslations();
  const maxCount = tags.reduce((m, row) => Math.max(m, row.count), 0) || 1;

  return (
    <ul className="space-y-2" data-slot="mood-structured-tag-breakdown">
      {tags.map((row) => {
        const Icon = moodTagIcon(row.icon);
        return (
          <li key={row.key} className="flex items-center gap-2 text-sm">
            <Icon
              className="text-muted-foreground h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            <span className="text-foreground w-28 shrink-0 truncate">
              {t(row.labelKey)}
            </span>
            <div className="bg-secondary relative h-3 flex-1 overflow-hidden rounded-full">
              {/* v1.16.8 — `opacity-55` matches the `fillOpacity={0.55}`
                  the mood Recharts bars carry (distribution / weekday /
                  time-of-day), so the tag bars read equally matte. */}
              <div
                className="absolute inset-y-0 left-0 rounded-full opacity-55"
                style={{
                  width: `${(row.count / maxCount) * 100}%`,
                  backgroundColor: colorForScore(row.avgScore),
                }}
              />
            </div>
            <span className="text-muted-foreground w-6 shrink-0 text-right tabular-nums">
              {row.count}
            </span>
            <span
              className="w-10 shrink-0 text-right text-xs font-medium tabular-nums"
              style={{ color: colorForScore(row.avgScore) }}
              title={t("insights.mood.tagAvgMood")}
            >
              {row.avgScore.toFixed(1)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
