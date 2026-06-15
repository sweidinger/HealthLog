"use client";

import { Archive, Folders, Loader2, Tags } from "lucide-react";

import { ArchivedTagsCard } from "@/components/mood/manage/archived-tags-card";
import { TagGroupsCard } from "@/components/mood/manage/tag-groups-card";
import { TagManagerCard } from "@/components/mood/manage/tag-manager-card";
import { useMoodTagManage } from "@/components/mood/manage/use-mood-tag-manage";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.17 — the "Stimmungs-Tags" settings section (`/settings/mood`),
 * following the medications-section card pattern. Hosts the whole
 * mood-tag management surface in three blocks:
 *   1. Groups — create / rename / delete own groups, drag + arrow
 *      reorder of the picker's group order.
 *   2. Tags — per-group tag list mirroring the picker: hide/show
 *      catalogue tags, edit / move / archive custom tags, drag + arrow
 *      reorder, create.
 *   3. Archived — archived custom tags with restore and the explicit
 *      hard-delete path.
 *
 * One management read (`useMoodTagManage`) feeds all three cards — the
 * section never waterfalls; every mutation invalidates the
 * `["mood-tag-catalog"]` prefix so the mood form's picker repaints in
 * the same tick.
 */

export function MoodSection() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  const { data: catalog, isLoading } = useMoodTagManage(isAuthenticated);

  const loading = (
    <div className="text-muted-foreground flex items-center gap-2 text-sm">
      <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
      {t("common.loading")}
    </div>
  );

  return (
    <section
      aria-labelledby="settings-section-mood-title"
      className="space-y-6"
    >
      <header className="space-y-1">
        <h1 id="settings-section-mood-title" className="sr-only">
          {t("settings.sections.mood.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.mood.description")}
        </p>
      </header>

      {/* Groups — picker group order + own groups. */}
      <div
        id="mood-groups"
        className="bg-card border-border scroll-mt-28 space-y-4 rounded-xl border p-4 sm:p-6"
      >
        <div className="flex items-center gap-2">
          <Folders className="text-muted-foreground h-5 w-5" />
          <h2 className="text-lg font-semibold">
            {t("mood.manage.groupsTitle")}
          </h2>
        </div>
        {isLoading || !catalog ? loading : <TagGroupsCard catalog={catalog} />}
      </div>

      {/* Tags — visibility, order, edit, move, create. */}
      <div
        id="mood-tags"
        className="bg-card border-border scroll-mt-28 space-y-4 rounded-xl border p-4 sm:p-6"
      >
        <div className="flex items-center gap-2">
          <Tags className="text-muted-foreground h-5 w-5" />
          <h2 className="text-lg font-semibold">
            {t("mood.manage.tagsTitle")}
          </h2>
        </div>
        {isLoading || !catalog ? loading : <TagManagerCard catalog={catalog} />}
      </div>

      {/* Archived custom tags — restore / hard delete. */}
      <div
        id="mood-archived"
        className="bg-card border-border scroll-mt-28 space-y-4 rounded-xl border p-4 sm:p-6"
      >
        <div className="flex items-center gap-2">
          <Archive className="text-muted-foreground h-5 w-5" />
          <h2 className="text-lg font-semibold">
            {t("mood.manage.archivedTitle")}
          </h2>
        </div>
        {isLoading || !catalog ? (
          loading
        ) : (
          <ArchivedTagsCard catalog={catalog} />
        )}
      </div>
    </section>
  );
}
