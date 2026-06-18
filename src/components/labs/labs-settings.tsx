"use client";

/**
 * v1.18.6 (W8 / MOD-03 + MOD-04) — the Labs module's own settings page body.
 *
 * Reached from the wrench beside the page's "hinzufügen" button. Lets the
 * user:
 *   - pick the card-vs-list page view (MOD-03),
 *   - choose the sort order (by most-recent reading, descending / ascending,
 *     or manual) — MOD-04,
 *   - reorder biomarkers when sort = manual (MOD-03/04),
 *   - and create / edit / delete biomarkers via the existing
 *     `BiomarkerManager` (MOD-04).
 * View / sort / order persist client-side via `useModuleListPrefs("labs")`.
 */
import { useQuery } from "@tanstack/react-query";

import { NativeSelect } from "@/components/ui/native-select";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { ModuleViewToggle } from "@/components/module-list/module-view-toggle";
import {
  ModuleOrderEditor,
  type ReorderItem,
} from "@/components/module-list/module-order-editor";
import {
  applyOrder,
  useModuleListPrefs,
  type ModuleSortDir,
} from "@/lib/module-list-prefs";

import { BiomarkerManager } from "./biomarker-manager";
import type { BiomarkerDto, BiomarkerListResponse } from "./types";

export function LabsSettings() {
  const { t } = useTranslations();
  const { prefs, setView, setOrder, setSortDir } = useModuleListPrefs("labs");

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.biomarkers(),
    queryFn: () => apiGet<BiomarkerListResponse>("/api/biomarkers"),
  });
  const markers: BiomarkerDto[] = data?.biomarkers ?? [];

  const ordered = applyOrder(markers, prefs.order, (m) => m.id);
  const reorderItems: ReorderItem[] = ordered.map((m) => ({
    id: m.id,
    name: m.name,
    secondary: m.panel ? `${m.unit} · ${m.panel}` : m.unit,
  }));

  const manual = prefs.sortDir === "manual";

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
        <h2 className="text-sm font-semibold">{t("labs.sort.heading")}</h2>
        <div className="space-y-2">
          <Label htmlFor="labs-sort">{t("labs.sort.label")}</Label>
          <NativeSelect
            id="labs-sort"
            value={prefs.sortDir}
            onChange={(e) => setSortDir(e.target.value as ModuleSortDir)}
          >
            <option value="recentDesc">{t("labs.sort.recentDesc")}</option>
            <option value="recentAsc">{t("labs.sort.recentAsc")}</option>
            <option value="manual">{t("labs.sort.manual")}</option>
          </NativeSelect>
          <p className="text-muted-foreground text-xs">
            {t("labs.sort.hint")}
          </p>
        </div>
      </section>

      {manual ? (
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
      ) : null}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">
          {t("labs.biomarker.manageTitle")}
        </h2>
        <BiomarkerManager />
      </section>
    </div>
  );
}
