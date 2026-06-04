"use client";

import { useQuery } from "@tanstack/react-query";

import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";
import { moodTagIcon } from "./mood-tag-icons";

/**
 * v1.8.5 / v1.12.0 — structured mood-tag capture surface (Daylio-style).
 *
 * Loads the global Category -> Tag catalog from `/api/mood/tags` and
 * renders one labelled group per category. Two tag kinds are surfaced:
 *
 *   - `BINARY` — an icon-above-label toggle tile. Multi-select across
 *     categories; the selection is a controlled set of tag keys lifted
 *     to the parent form, which sends them as `tagKeys` on create.
 *   - `RATED` — a 1..scaleMax segmented control (a Yes/No pair when
 *     `scaleMax === 2`). The score is lifted as a `{ key, rating }`
 *     entry and sent as `ratedFactors`. `inverse` factors (higher =
 *     worse day) carry the same control; the inversion is a read-side
 *     concern handled server-side.
 *
 * Additive next to the legacy free-text tag input: a user can use
 * either or both. Renders nothing if the catalog is empty so a
 * deployment that cleared the taxonomy degrades to the free-text field.
 */

interface CatalogTag {
  key: string;
  labelKey: string;
  icon: string | null;
  kind: "BINARY" | "RATED";
  scaleMin: number;
  scaleMax: number;
  inverse: boolean;
}

interface CatalogCategory {
  key: string;
  labelKey: string;
  icon: string | null;
  tags: CatalogTag[];
}

interface CatalogResponse {
  categories: CatalogCategory[];
}

export interface RatedFactor {
  key: string;
  rating: number;
}

export function MoodTagPicker({
  selected,
  onToggle,
  ratedFactors = [],
  onRateFactor,
}: {
  /** Selected binary tag keys (sent as `tagKeys`). */
  selected: string[];
  onToggle: (tagKey: string) => void;
  /** Current rated-factor scores (sent as `ratedFactors`). */
  ratedFactors?: RatedFactor[];
  /**
   * Sets (or, when `rating === null`, clears) a rated factor's score.
   * Required for the RATED segmented controls to render interactively;
   * when omitted the picker only surfaces binary tags.
   */
  onRateFactor?: (key: string, rating: number | null) => void;
}) {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.moodTagCatalog(),
    queryFn: async () => {
      const res = await fetch("/api/mood/tags");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as CatalogResponse;
    },
    enabled: isAuthenticated,
    // The catalog only changes on a migration / admin edit.
    staleTime: 60 * 60 * 1000,
  });

  if (isLoading) {
    return <Skeleton className="h-24 w-full rounded-lg" />;
  }

  if (!data || data.categories.length === 0) {
    return null;
  }

  const selectedSet = new Set(selected);
  const ratingByKey = new Map(ratedFactors.map((f) => [f.key, f.rating]));

  return (
    <div className="space-y-4" data-slot="mood-tag-picker">
      {data.categories.map((category) => {
        const CategoryIcon = moodTagIcon(category.icon);
        const binaryTags = category.tags.filter((tag) => tag.kind !== "RATED");
        const ratedTags = category.tags.filter((tag) => tag.kind === "RATED");
        // Self-gate an empty category (e.g. a RATED-only category when no
        // `onRateFactor` is wired) so the picker never shows a bare heading.
        if (binaryTags.length === 0 && ratedTags.length === 0) return null;
        if (ratedTags.length > 0 && !onRateFactor && binaryTags.length === 0) {
          return null;
        }

        return (
          <div key={category.key} className="space-y-2">
            <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
              <CategoryIcon className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{t(category.labelKey)}</span>
            </div>

            {binaryTags.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {binaryTags.map((tag) => {
                  const TagIcon = moodTagIcon(tag.icon);
                  const isActive = selectedSet.has(tag.key);
                  const label = t(tag.labelKey);
                  return (
                    <button
                      key={tag.key}
                      type="button"
                      onClick={() => onToggle(tag.key)}
                      aria-pressed={isActive}
                      data-slot="mood-tag-tile"
                      className={`flex min-h-16 w-[4.5rem] flex-col items-center justify-center gap-1 rounded-xl border p-2 text-center transition-colors ${
                        isActive
                          ? "border-primary bg-primary/15 text-primary"
                          : "border-border/70 bg-muted text-foreground/75 hover:bg-accent hover:text-foreground"
                      }`}
                    >
                      <TagIcon className="h-5 w-5" aria-hidden="true" />
                      <span className="text-[11px] leading-tight">{label}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {ratedTags.length > 0 && onRateFactor && (
              <div className="space-y-2" data-slot="mood-factor-ratings">
                {ratedTags.map((tag) => {
                  const TagIcon = moodTagIcon(tag.icon);
                  const label = t(tag.labelKey);
                  const current = ratingByKey.get(tag.key);
                  const isBinaryScale = tag.scaleMax - tag.scaleMin === 1;
                  const steps: number[] = [];
                  for (let v = tag.scaleMin; v <= tag.scaleMax; v++) {
                    steps.push(v);
                  }
                  const groupLabelId = `mood-factor-${tag.key}`;
                  return (
                    <div
                      key={tag.key}
                      className="flex items-center justify-between gap-3"
                      data-slot="mood-factor-rating"
                    >
                      <span
                        id={groupLabelId}
                        className="text-foreground/85 flex items-center gap-1.5 text-xs"
                      >
                        <TagIcon className="h-4 w-4" aria-hidden="true" />
                        {label}
                      </span>
                      <div
                        role="radiogroup"
                        aria-labelledby={groupLabelId}
                        className="flex items-center gap-1"
                      >
                        {steps.map((value) => {
                          const isActive = current === value;
                          const optionLabel = isBinaryScale
                            ? value === tag.scaleMax
                              ? t("mood.factorYes")
                              : t("mood.factorNo")
                            : String(value);
                          const a11yLabel = isBinaryScale
                            ? optionLabel
                            : t("mood.factorRatingOption", {
                                label,
                                value: String(value),
                                max: String(tag.scaleMax),
                              });
                          return (
                            <button
                              key={value}
                              type="button"
                              role="radio"
                              aria-checked={isActive}
                              aria-label={a11yLabel}
                              // Re-tap the active step to clear the score.
                              onClick={() =>
                                onRateFactor(tag.key, isActive ? null : value)
                              }
                              // v1.12 — `rounded-lg` aligns the step
                              // radius with the tag tiles and mood faces;
                              // selected-state matches them too.
                              className={`flex h-8 items-center justify-center rounded-lg border px-2 text-xs tabular-nums transition-colors ${
                                isBinaryScale ? "min-w-12" : "min-w-8"
                              } ${
                                isActive
                                  ? "border-primary bg-primary/15 text-primary"
                                  : "border-border/70 bg-muted text-foreground/75 hover:bg-accent hover:text-foreground"
                              }`}
                            >
                              {optionLabel}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
