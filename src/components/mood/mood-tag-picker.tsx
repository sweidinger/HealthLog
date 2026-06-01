"use client";

import { useQuery } from "@tanstack/react-query";

import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";
import { moodTagIcon } from "./mood-tag-icons";

/**
 * v1.8.5 — structured mood-tag capture surface.
 *
 * Loads the global Category -> Tag catalog from `/api/mood/tags` and
 * renders one labelled group per category with icon chips the user can
 * toggle. Selection is a controlled set of tag keys lifted to the
 * parent form, which sends them as `tagKeys` on create / update.
 *
 * Additive next to the legacy free-text tag input: a user can use
 * either or both. Renders nothing if the catalog is empty so a
 * deployment that cleared the taxonomy degrades to the free-text field.
 */

interface CatalogTag {
  key: string;
  labelKey: string;
  icon: string | null;
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

export function MoodTagPicker({
  selected,
  onToggle,
}: {
  selected: string[];
  onToggle: (tagKey: string) => void;
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

  return (
    <div className="space-y-3" data-slot="mood-tag-picker">
      {data.categories.map((category) => {
        const CategoryIcon = moodTagIcon(category.icon);
        return (
          <div key={category.key} className="space-y-1.5">
            <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
              <CategoryIcon className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{t(category.labelKey)}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {category.tags.map((tag) => {
                const TagIcon = moodTagIcon(tag.icon);
                const isActive = selectedSet.has(tag.key);
                const label = t(tag.labelKey);
                return (
                  <button
                    key={tag.key}
                    type="button"
                    onClick={() => onToggle(tag.key)}
                    aria-pressed={isActive}
                    className={`inline-flex min-h-8 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                      isActive
                        ? "border-primary bg-primary/15 text-primary"
                        : "border-border/70 bg-muted text-foreground/75 hover:bg-accent hover:text-foreground"
                    }`}
                  >
                    <TagIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
