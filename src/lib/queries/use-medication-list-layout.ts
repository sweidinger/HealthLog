"use client";

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiGet, apiPut } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";
import {
  DEFAULT_MEDICATION_LIST_LAYOUT,
  type MedicationListLayout,
  type MedicationListView,
} from "@/lib/medication-list-layout";

type Translator = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/**
 * v1.16.10 — the /medications presentation preference (cards/table view
 * + manual order), persisted per user through
 * `GET`/`PUT /api/medications/layout`.
 *
 * The PUT is field-scoped: the server preserves whichever of `view` /
 * `order` the body omits, so the two writers below each send only the
 * field they own and can never wipe the other one.
 *
 * The orchestration lives in dependency-injected `run*` functions (the
 * repo convention from `use-medication-intake.ts`) so the optimistic
 * write + rollback contract is unit-testable without a React render.
 */

/**
 * Flip the view optimistically (the toggle must feel instant), then
 * persist. On failure the cache rolls back to the previous layout and
 * a calm toast surfaces — the user is back on the view they came from.
 */
export async function runSetMedicationListView(deps: {
  view: MedicationListView;
  queryClient: QueryClient;
  t: Translator;
}): Promise<void> {
  const { view, queryClient, t } = deps;
  const key = queryKeys.medicationListLayout();
  const previous = queryClient.getQueryData<MedicationListLayout>(key);
  queryClient.setQueryData<MedicationListLayout>(key, {
    ...(previous ?? DEFAULT_MEDICATION_LIST_LAYOUT),
    view,
  });
  try {
    const saved = await apiPut<MedicationListLayout>(
      "/api/medications/layout",
      { version: 1, view },
    );
    if (saved) queryClient.setQueryData(key, saved);
  } catch {
    queryClient.setQueryData(key, previous);
    toast.error(t("medications.viewSaveFailed"));
  }
}

/**
 * Persist a manual medication order (the reorder dialog's Save). Not
 * optimistic — the dialog stays open until the PUT resolves, mirroring
 * the dashboard layout section's explicit Save. Returns whether the
 * save landed so the dialog knows to close.
 */
export async function runSaveMedicationListOrder(deps: {
  order: string[];
  queryClient: QueryClient;
  t: Translator;
}): Promise<boolean> {
  const { order, queryClient, t } = deps;
  try {
    const saved = await apiPut<MedicationListLayout>(
      "/api/medications/layout",
      { version: 1, order },
    );
    if (saved) {
      queryClient.setQueryData(queryKeys.medicationListLayout(), saved);
    }
    toast.success(t("medications.reorderSaved"));
    return true;
  } catch {
    toast.error(t("medications.reorderSaveFailed"));
    return false;
  }
}

export function useMedicationListLayout(enabled: boolean = true): {
  /** Resolved layout — defaults until the GET lands. */
  layout: MedicationListLayout;
  /** True while the preference GET is in flight (first load only). */
  isLayoutLoading: boolean;
  setView: (view: MedicationListView) => Promise<void>;
  saveOrder: (order: string[]) => Promise<boolean>;
} {
  const queryClient = useQueryClient();
  const { t } = useTranslations();

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.medicationListLayout(),
    queryFn: () => apiGet<MedicationListLayout>("/api/medications/layout"),
    staleTime: 5 * 60 * 1000,
    enabled,
  });

  return {
    layout: data ?? DEFAULT_MEDICATION_LIST_LAYOUT,
    isLayoutLoading: enabled && isLoading,
    setView: (view) => runSetMedicationListView({ view, queryClient, t }),
    saveOrder: (order) =>
      runSaveMedicationListOrder({ order, queryClient, t }),
  };
}
