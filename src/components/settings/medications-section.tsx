"use client";

import { useQuery } from "@tanstack/react-query";
import { LayoutGrid, Loader2, Pill } from "lucide-react";

import {
  MedicationOrderEditor,
  type ReorderMedication,
} from "@/components/medications/medication-order-editor";
import { MedicationViewToggle } from "@/components/medications/medication-view-toggle";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { applyMedicationOrder } from "@/lib/medications/medication-order";
import { queryKeys } from "@/lib/query-keys";
import { useMedicationListLayout } from "@/lib/queries/use-medication-list-layout";

/**
 * v1.16.10 — the "Medikamente" settings section (analogous to the
 * Dashboard and Insights sections). Hosts two blocks:
 *   1. The list VIEW preference — cards vs table, written optimistically
 *      through the same `PUT /api/medications/layout` the page header
 *      toggle uses (the toggle component is shared).
 *   2. The manual ORDER editor — two grouped lists (Aktiv / Inaktiv)
 *      with drag + arrow reordering, flushed by an explicit Save,
 *      persisted as active-ids-then-inactive-ids on the same layout row.
 *
 * Both write through the same `/api/medications/layout` contract the
 * /medications page reads, so a save here repaints both list views.
 */

/** The slice of the medications list the order editor needs. */
interface MedicationListEntry {
  id: string;
  name: string;
  dose: string;
  active: boolean;
}

export function MedicationsSection() {
  const { t } = useTranslations();
  const { layout, isLayoutLoading, setView } = useMedicationListLayout();

  const { data: medications, isLoading } = useQuery({
    queryKey: queryKeys.medications(),
    queryFn: async () => {
      return apiGet<MedicationListEntry[]>("/api/medications");
    },
  });

  // Defensive against stale service-worker responses or any future API
  // shape change: only map when we actually have an array. The editor
  // receives the page's current effective order (active block first,
  // inactive after) so it opens showing exactly what both views render.
  const medsArray = Array.isArray(medications) ? medications : [];
  const ordered: ReorderMedication[] = [
    ...applyMedicationOrder(
      medsArray.filter((m) => m.active),
      layout.order,
    ),
    ...applyMedicationOrder(
      medsArray.filter((m) => !m.active),
      layout.order,
    ),
  ].map((m) => ({ id: m.id, name: m.name, dose: m.dose, active: m.active }));

  return (
    <section
      aria-labelledby="settings-section-medications-title"
      className="space-y-6"
    >
      <header className="space-y-1">
        <h1 id="settings-section-medications-title" className="sr-only">
          {t("settings.sections.medications.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.medications.description")}
        </p>
      </header>

      {/* View preference — cards vs table. The shared header toggle
          writes optimistically, so there is no Save button here. */}
      <div
        id="medications-view"
        className="bg-card border-border scroll-mt-28 space-y-4 rounded-xl border p-4 sm:p-6"
      >
        <div className="flex items-center gap-2">
          <LayoutGrid className="text-muted-foreground h-5 w-5" />
          <h2 className="text-lg font-semibold">
            {t("medications.viewToggleLabel")}
          </h2>
        </div>
        <div className="border-border bg-background/30 flex min-h-12 items-center justify-between gap-3 rounded-md border px-3 py-2">
          <p className="text-muted-foreground min-w-0 text-xs">
            {t("medications.viewToggleHint")}
          </p>
          {isLayoutLoading ? (
            <Loader2 className="text-muted-foreground h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <MedicationViewToggle view={layout.view} onChange={setView} />
          )}
        </div>
      </div>

      {/* Manual order — applies to both list views. */}
      <div
        id="medications-order"
        className="bg-card border-border scroll-mt-28 space-y-4 rounded-xl border p-4 sm:p-6"
      >
        <div className="flex items-center gap-2">
          <Pill className="text-muted-foreground h-5 w-5" />
          <h2 className="text-lg font-semibold">
            {t("medications.reorderTitle")}
          </h2>
        </div>
        <p className="text-muted-foreground text-xs">
          {t("medications.reorderDescription")}
        </p>
        {isLoading || isLayoutLoading ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            {t("common.loading")}
          </div>
        ) : (
          <MedicationOrderEditor medications={ordered} />
        )}
      </div>
    </section>
  );
}
