"use client";

/**
 * v1.15.18 — Bestand (supply) tab body.
 *
 * Read-only inventory readout for the medication detail page's Supply
 * tab. Reads `GET /api/medications/[id]/inventory` (the same per-item
 * list the pen/vial CRUD route serves) and renders a calm summary — the
 * doses remaining across every non-terminal item plus a per-item list
 * with its state badge. Shown for ALL medications (pill packs count too);
 * the richer pen math is implicit in the per-item doses figures.
 *
 * No write affordance here yet — registering a pen still rides the
 * dedicated inventory route; the tab is the read surface the spec asks
 * for. An empty inventory shows a quiet empty state, not a spinner.
 */

import { useQuery } from "@tanstack/react-query";
import { Loader2, PackageOpen } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { SettingsGroup } from "@/components/medications/settings-group";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

type InventoryState = "ACTIVE" | "IN_USE" | "EXPIRED" | "USED_UP";

interface InventoryItem {
  id: string;
  state: InventoryState;
  dosesTotal: number;
  dosesRemaining: number;
}

interface InventoryResponse {
  items: InventoryItem[];
  meta?: { total: number };
}

const STATE_BADGE: Record<InventoryState, "secondary" | "outline" | "destructive"> = {
  ACTIVE: "secondary",
  IN_USE: "secondary",
  EXPIRED: "destructive",
  USED_UP: "outline",
};

export function InventorySection({ medicationId }: { medicationId: string }) {
  const { t } = useTranslations();

  const { data, isLoading } = useQuery<InventoryResponse>({
    queryKey: queryKeys.medicationInventory(medicationId),
    queryFn: async () => {
      const res = await fetch(`/api/medications/${medicationId}/inventory`);
      if (!res.ok) throw new Error("inventory_failed");
      return (await res.json()).data as InventoryResponse;
    },
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div
        className="flex h-32 items-center justify-center"
        role="status"
        aria-busy="true"
        aria-live="polite"
      >
        <Loader2
          aria-hidden="true"
          className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none"
        />
      </div>
    );
  }

  const items = Array.isArray(data?.items) ? data.items : [];
  // Active supply: doses left across every non-terminal (not used-up) item.
  const live = items.filter((i) => i.state !== "USED_UP");
  const remaining = live.reduce((sum, i) => sum + i.dosesRemaining, 0);
  const total = live.reduce((sum, i) => sum + i.dosesTotal, 0);

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<PackageOpen className="size-6" />}
        title={t("medications.detail.bestand.empty")}
        description={t("medications.detail.bestand.emptyHelper")}
      />
    );
  }

  return (
    <div className="space-y-4" data-slot="medication-inventory-section">
      <SettingsGroup
        label={t("medications.detail.bestand.title")}
        dataSlot="inventory-summary-group"
      >
        <div className="py-3">
          <p className="text-foreground text-sm font-medium">
            {t("medications.detail.bestand.summary", { remaining, total })}
          </p>
        </div>
      </SettingsGroup>

      <SettingsGroup
        label={t("medications.detail.bestand.itemsTitle")}
        dataSlot="inventory-items-group"
      >
        {items.map((item) => (
          <div
            key={item.id}
            className="flex items-center justify-between gap-3 py-3"
            data-slot="inventory-item-row"
          >
            <span className="text-foreground text-sm">
              {t("medications.detail.bestand.doses", {
                remaining: item.dosesRemaining,
                total: item.dosesTotal,
              })}
            </span>
            <Badge variant={STATE_BADGE[item.state]} className="text-xs">
              {t(`medications.detail.bestand.state.${item.state}`)}
            </Badge>
          </div>
        ))}
      </SettingsGroup>
    </div>
  );
}
