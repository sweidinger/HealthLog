"use client";

/**
 * v1.18.6 (W8 / MOD-03) — the Illness module's own settings page body.
 *
 * Reached from the wrench beside the page's "hinzufügen" button. Lets the
 * user reorder conditions/episodes + pick the card-vs-list page view. Order
 * + view persist client-side via `useModuleListPrefs("illness")`.
 */
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { ModuleViewToggle } from "@/components/module-list/module-view-toggle";
import {
  ModuleOrderEditor,
  type ReorderItem,
} from "@/components/module-list/module-order-editor";
import { applyOrder, useModuleListPrefs } from "@/lib/module-list-prefs";
import { useIllnessEpisodes } from "./use-illness";

export function IllnessSettings() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { data: episodes, isLoading } = useIllnessEpisodes(true);
  const { prefs, setView, setOrder } = useModuleListPrefs("illness");

  const ordered = applyOrder(episodes ?? [], prefs.order, (e) => e.id);
  const reorderItems: ReorderItem[] = ordered.map((e) => ({
    id: e.id,
    name: e.label,
    secondary: `${t(`illness.type.${e.type}`)} · ${
      e.resolvedAt
        ? t("illness.status.recovered")
        : e.lifecycle === "CHRONIC_ONGOING"
          ? t("illness.status.ongoing")
          : t("illness.status.active")
    } · ${fmt.dateShort(new Date(e.onsetAt))}`,
  }));

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">
            {t("moduleList.viewHeading")}
          </h2>
          <ModuleViewToggle view={prefs.view} onChange={setView} />
        </div>
        <p className="text-muted-foreground text-sm">
          {t("moduleList.viewDescription")}
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">
          {t("moduleList.reorder.heading")}
        </h2>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : (
          <ModuleOrderEditor items={reorderItems} onChange={setOrder} />
        )}
      </section>
    </div>
  );
}
