"use client";

/**
 * v1.15.18 — Bestand (supply) tab body.
 *
 * v1.16.1 — the tab grows its write affordances:
 *
 *   - REGISTER: a "+" flow (header button + the empty-state CTA) that
 *     records a new pen / pack via `POST /api/medications/[id]/inventory`
 *     — quantity in doses/units, optional printed expiry. The quantity
 *     prefills from the medication's `dosesPerUnit` when configured.
 *   - CORRECT: a per-item adjust flow (`PATCH …/inventory/[itemId]` with
 *     `dosesRemaining`) for stock corrections and manual withdrawals —
 *     the count is set absolutely, clamped server-side to the item's
 *     capacity, and the canonical state machine derives the next state
 *     (0 ⇒ used up).
 *
 * Reads stay on `GET /api/medications/[id]/inventory` (the same
 * per-item list the pen/vial CRUD route serves): a calm summary — the
 * doses remaining across every non-terminal item — plus a per-item list
 * with its state badge. Shown for ALL medications (pill packs count
 * too); the richer pen math is implicit in the per-item doses figures.
 */

import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, PackageOpen, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { SettingsGroup } from "@/components/medications/settings-group";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiGet, apiPatch, apiPost } from "@/lib/api/api-fetch";

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

export function InventorySection({
  medicationId,
  dosesPerUnit,
}: {
  medicationId: string;
  /** Prefills the register flow's quantity when the medication tracks it. */
  dosesPerUnit?: number | null;
}) {
  const { t } = useTranslations();
  const [addOpen, setAddOpen] = useState(false);
  const [adjustItem, setAdjustItem] = useState<InventoryItem | null>(null);

  const { data, isLoading } = useQuery<InventoryResponse>({
    queryKey: queryKeys.medicationInventory(medicationId),
    queryFn: async () => {
      return apiGet<InventoryResponse>(`/api/medications/${medicationId}/inventory`);
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

  const dialogs = (
    <>
      {addOpen && (
        <AddInventoryDialog
          medicationId={medicationId}
          defaultDosesTotal={dosesPerUnit ?? null}
          onClose={() => setAddOpen(false)}
        />
      )}
      {adjustItem && (
        <AdjustInventoryDialog
          medicationId={medicationId}
          item={adjustItem}
          onClose={() => setAdjustItem(null)}
        />
      )}
    </>
  );

  if (items.length === 0) {
    return (
      <>
        <EmptyState
          icon={<PackageOpen className="size-6" />}
          title={t("medications.detail.bestand.empty")}
          description={t("medications.detail.bestand.emptyHelper")}
          ctaSize="lg"
          action={
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              {t("medications.detail.bestand.emptyCta")}
            </Button>
          }
        />
        {dialogs}
      </>
    );
  }

  return (
    <div className="space-y-4" data-slot="medication-inventory-section">
      <SettingsGroup
        label={t("medications.detail.bestand.title")}
        dataSlot="inventory-summary-group"
      >
        <div className="flex items-center justify-between gap-3 py-3">
          <p className="text-foreground text-sm font-medium">
            {t("medications.detail.bestand.summary", { remaining, total })}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAddOpen(true)}
            className="min-h-11 shrink-0 sm:min-h-9"
            data-slot="inventory-add-button"
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            {t("medications.detail.bestand.addButton")}
          </Button>
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
            <span className="flex shrink-0 items-center gap-1">
              <Badge variant={STATE_BADGE[item.state]} className="text-xs">
                {t(`medications.detail.bestand.state.${item.state}`)}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAdjustItem(item)}
                className="min-h-11 sm:min-h-9"
                data-slot="inventory-adjust-button"
              >
                {t("medications.detail.bestand.adjustButton")}
              </Button>
            </span>
          </div>
        ))}
      </SettingsGroup>

      {dialogs}
    </div>
  );
}

/**
 * Register a new pen / pack. Two fields (quantity + optional printed
 * expiry) → Dialog per ui-guidelines §2.3. The quantity prefills from
 * the medication's `dosesPerUnit` so the common case is one tap.
 */
function AddInventoryDialog({
  medicationId,
  defaultDosesTotal,
  onClose,
}: {
  medicationId: string;
  defaultDosesTotal: number | null;
  onClose: () => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [dosesTotal, setDosesTotal] = useState(
    defaultDosesTotal && defaultDosesTotal >= 1 && defaultDosesTotal <= 100
      ? String(defaultDosesTotal)
      : "",
  );
  const [expiry, setExpiry] = useState("");
  const [busy, setBusy] = useState(false);

  const parsed = Number(dosesTotal);
  const quantityValid =
    Number.isInteger(parsed) && parsed >= 1 && parsed <= 100;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!quantityValid || busy) return;
    setBusy(true);
    try {
      await apiPost(`/api/medications/${medicationId}/inventory`, {
        dosesTotal: parsed,
        printedExpiry: expiry
          ? new Date(`${expiry}T00:00:00`).toISOString()
          : null,
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.medicationInventory(medicationId),
      });
      toast.success(t("medications.detail.bestand.addSuccess"));
      onClose();
    } catch {
      toast.error(t("medications.detail.bestand.addFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("medications.detail.bestand.addTitle")}</DialogTitle>
          <DialogDescription>
            {t("medications.detail.bestand.addDescription")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <label
              htmlFor="inventory-add-quantity"
              className="text-sm font-medium"
            >
              {t("medications.detail.bestand.addQuantityLabel")}
            </label>
            <Input
              id="inventory-add-quantity"
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              step={1}
              required
              autoComplete="off"
              value={dosesTotal}
              onChange={(e) => setDosesTotal(e.target.value)}
              aria-describedby="inventory-add-quantity-helper"
            />
            <p
              id="inventory-add-quantity-helper"
              className="text-muted-foreground text-xs"
            >
              {t("medications.detail.bestand.addQuantityHelper")}
            </p>
          </div>
          <div className="space-y-2">
            <label
              htmlFor="inventory-add-expiry"
              className="text-sm font-medium"
            >
              {t("medications.detail.bestand.addExpiryLabel")}
            </label>
            <Input
              id="inventory-add-expiry"
              type="date"
              autoComplete="off"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={!quantityValid || busy}
              aria-busy={busy || undefined}
            >
              {busy && (
                <Loader2
                  aria-hidden="true"
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                />
              )}
              {t("medications.detail.bestand.addSubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Stock correction for one item: sets the remaining-dose count
 * absolutely (covers both "I miscounted" and a manual withdrawal). The
 * server clamps to the item's capacity and re-derives the state; 0
 * marks the item used up.
 */
function AdjustInventoryDialog({
  medicationId,
  item,
  onClose,
}: {
  medicationId: string;
  item: InventoryItem;
  onClose: () => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [value, setValue] = useState(String(item.dosesRemaining));
  const [busy, setBusy] = useState(false);

  const parsed = Number(value);
  const valid =
    Number.isInteger(parsed) && parsed >= 0 && parsed <= item.dosesTotal;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    try {
      await apiPatch(`/api/medications/${medicationId}/inventory/${item.id}`, {
        dosesRemaining: parsed,
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.medicationInventory(medicationId),
      });
      toast.success(t("medications.detail.bestand.adjustSuccess"));
      onClose();
    } catch {
      toast.error(t("medications.detail.bestand.adjustFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("medications.detail.bestand.adjustTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("medications.detail.bestand.adjustDescription")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <label
              htmlFor="inventory-adjust-remaining"
              className="text-sm font-medium"
            >
              {t("medications.detail.bestand.adjustQuantityLabel")}
            </label>
            <Input
              id="inventory-adjust-remaining"
              type="number"
              inputMode="numeric"
              min={0}
              max={item.dosesTotal}
              step={1}
              required
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-describedby="inventory-adjust-helper"
            />
            <p
              id="inventory-adjust-helper"
              className="text-muted-foreground text-xs"
            >
              {t("medications.detail.bestand.adjustHelper", {
                total: item.dosesTotal,
              })}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={!valid || busy}
              aria-busy={busy || undefined}
            >
              {busy && (
                <Loader2
                  aria-hidden="true"
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                />
              )}
              {t("medications.detail.bestand.adjustSubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
