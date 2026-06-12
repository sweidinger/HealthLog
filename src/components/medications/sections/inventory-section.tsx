"use client";

/**
 * v1.15.18 — Bestand (supply) tab body.
 *
 * v1.16.1 — the tab grows its write affordances:
 *
 *   - REGISTER: a "+" flow (header button + the empty-state CTA) that
 *     records a new pack / container via
 *     `POST /api/medications/[id]/inventory` — quantity in units,
 *     optional printed expiry. The quantity prefills from the
 *     medication's `dosesPerUnit` when configured.
 *   - CORRECT: a per-item adjust flow (`PATCH …/inventory/[itemId]` with
 *     `unitsRemaining`) for stock corrections and manual withdrawals —
 *     the count is set absolutely, clamped server-side to the item's
 *     capacity, and the canonical state machine derives the next state
 *     (0 ⇒ used up).
 *
 * v1.16.10 — items count UNITS (tablets / ampoules / puffs);
 * `Medication.unitsPerDose` maps units to doses. Every dose-facing
 * readout divides by it (floor), with the raw unit count as secondary
 * text when the factor is > 1. The register flow gains a container-type
 * select (pen / ampoule / tablet pack / …, defaulted from the delivery
 * form) and, for multi-unit doses, a segmented Dosen | Einheiten
 * quantity input with live conversion — the wire always carries units.
 *
 * Reads stay on `GET /api/medications/[id]/inventory` (the same
 * per-item list the inventory CRUD route serves): a calm summary — the
 * doses remaining across every non-terminal item — plus a per-item list
 * with its container type and state badge. Shown for ALL medications
 * (pill packs count too).
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsGroup } from "@/components/medications/settings-group";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiGet, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { summariseSupply } from "@/lib/medications/inventory/summary";

type InventoryState = "ACTIVE" | "IN_USE" | "EXPIRED" | "USED_UP";

const CONTAINER_TYPES = [
  "PEN",
  "AMPOULE",
  "BLISTER",
  "INHALER",
  "BOTTLE",
  "OTHER",
] as const;
type ContainerType = (typeof CONTAINER_TYPES)[number];

interface InventoryItem {
  id: string;
  state: InventoryState;
  containerType: ContainerType;
  unitsTotal: number;
  unitsRemaining: number;
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

/** Default container kind for the register flow, from the delivery form. */
function defaultContainerType(deliveryForm: string | undefined): ContainerType {
  if (deliveryForm === "INJECTION") return "PEN";
  if (deliveryForm === "ORAL") return "BLISTER";
  return "OTHER";
}

export function InventorySection({
  medicationId,
  dosesPerUnit,
  unitsPerDose,
  deliveryForm,
}: {
  medicationId: string;
  /** Prefills the register flow's quantity when the medication tracks it. */
  dosesPerUnit?: number | null;
  /** Units one dose consumes; dose-derived readouts divide by it. */
  unitsPerDose?: number | null;
  /** Defaults the register flow's container type. */
  deliveryForm?: string;
}) {
  const { t } = useTranslations();
  const [addOpen, setAddOpen] = useState(false);
  const [adjustItem, setAdjustItem] = useState<InventoryItem | null>(null);

  const perDose = Math.max(1, unitsPerDose ?? 1);

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
  // Available supply: ACTIVE / IN_USE containers with units left — the
  // shared summary helper keeps this row, the Übersicht row, the list
  // payload and the GLP-1 endpoint on one predicate. Expired stock is
  // never available; it renders as a separate muted suffix.
  // Dose-derived headline (floor — a partial dose is not a dose).
  const {
    unitsRemaining: remainingUnits,
    unitsTotal: totalUnits,
    dosesRemaining: remaining,
    dosesTotal: total,
    expiredUnits,
  } = summariseSupply(items, perDose);

  const dialogs = (
    <>
      {addOpen && (
        <AddInventoryDialog
          medicationId={medicationId}
          defaultUnitsTotal={dosesPerUnit ?? null}
          unitsPerDose={perDose}
          initialContainerType={defaultContainerType(deliveryForm)}
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
            {perDose > 1 && (
              <span className="text-muted-foreground block text-xs font-normal">
                {t("medications.detail.bestand.unitsDetail", {
                  remaining: remainingUnits,
                  total: totalUnits,
                })}
              </span>
            )}
            {expiredUnits > 0 && (
              <span
                className="text-muted-foreground block text-xs font-normal"
                data-slot="inventory-expired-suffix"
              >
                {t("medications.detail.bestand.expiredSuffix", {
                  units: expiredUnits,
                })}
              </span>
            )}
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
              <span className="block">
                {t(
                  `medications.detail.bestand.containerType.${item.containerType}`,
                )}
              </span>
              <span className="text-muted-foreground block text-xs">
                {t("medications.detail.bestand.doses", {
                  remaining: Math.floor(item.unitsRemaining / perDose),
                  total: Math.floor(item.unitsTotal / perDose),
                })}
                {perDose > 1 && (
                  <>
                    {" · "}
                    {t("medications.detail.bestand.unitsDetail", {
                      remaining: item.unitsRemaining,
                      total: item.unitsTotal,
                    })}
                  </>
                )}
              </span>
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
 * Register a new pack / container. Quantity (units), container type and
 * optional printed expiry → Dialog per ui-guidelines §2.3. The quantity
 * prefills from the medication's `dosesPerUnit` so the common case is
 * one tap. For multi-unit doses (`unitsPerDose > 1`) a segmented
 * Dosen | Einheiten control converts live — the POST always carries
 * units.
 */
export function AddInventoryDialog({
  medicationId,
  defaultUnitsTotal,
  unitsPerDose,
  initialContainerType,
  onClose,
}: {
  medicationId: string;
  defaultUnitsTotal: number | null;
  unitsPerDose: number;
  initialContainerType: ContainerType;
  onClose: () => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [quantity, setQuantity] = useState(
    defaultUnitsTotal && defaultUnitsTotal >= 1 && defaultUnitsTotal <= 1000
      ? String(defaultUnitsTotal)
      : "",
  );
  // The unit the typed quantity is read in. Only surfaced when a dose
  // spans several units; the stored value is ALWAYS units.
  const [quantityMode, setQuantityMode] = useState<"units" | "doses">("units");
  const [containerType, setContainerType] =
    useState<ContainerType>(initialContainerType);
  const [expiry, setExpiry] = useState("");
  const [busy, setBusy] = useState(false);

  const parsed = Number(quantity);
  const effectiveMode = unitsPerDose > 1 ? quantityMode : "units";
  const units =
    effectiveMode === "doses" ? parsed * unitsPerDose : parsed;
  const quantityValid =
    Number.isInteger(parsed) && parsed >= 1 && units >= 1 && units <= 1000;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!quantityValid || busy) return;
    setBusy(true);
    try {
      await apiPost(`/api/medications/${medicationId}/inventory`, {
        // The wire field carries UNITS (v1.16.10 symmetric naming).
        unitsTotal: units,
        containerType,
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
              htmlFor="inventory-add-container-type"
              className="text-sm font-medium"
            >
              {t("medications.detail.bestand.containerTypeLabel")}
            </label>
            <Select
              value={containerType}
              onValueChange={(v) => setContainerType(v as ContainerType)}
            >
              <SelectTrigger
                id="inventory-add-container-type"
                className="w-full"
                data-slot="inventory-container-type"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTAINER_TYPES.map((ct) => (
                  <SelectItem key={ct} value={ct}>
                    {t(`medications.detail.bestand.containerType.${ct}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label
              htmlFor="inventory-add-quantity"
              className="text-sm font-medium"
            >
              {t("medications.detail.bestand.addQuantityLabel")}
            </label>
            {unitsPerDose > 1 && (
              <div
                className="border-border/60 inline-flex rounded-md border p-0.5"
                role="group"
                aria-label={t("medications.detail.bestand.addQuantityLabel")}
                data-slot="inventory-quantity-mode"
              >
                <Button
                  type="button"
                  size="sm"
                  variant={quantityMode === "doses" ? "secondary" : "ghost"}
                  aria-pressed={quantityMode === "doses"}
                  className="h-7 px-2 text-xs"
                  onClick={() => setQuantityMode("doses")}
                >
                  {t("medications.detail.bestand.quantityModeDoses")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={quantityMode === "units" ? "secondary" : "ghost"}
                  aria-pressed={quantityMode === "units"}
                  className="h-7 px-2 text-xs"
                  onClick={() => setQuantityMode("units")}
                >
                  {t("medications.detail.bestand.quantityModeUnits")}
                </Button>
              </div>
            )}
            <Input
              id="inventory-add-quantity"
              type="number"
              inputMode="numeric"
              min={1}
              max={effectiveMode === "doses" ? Math.floor(1000 / unitsPerDose) : 1000}
              step={1}
              required
              autoComplete="off"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              aria-describedby="inventory-add-quantity-helper"
            />
            {unitsPerDose > 1 && Number.isInteger(parsed) && parsed >= 1 && (
              <p
                className="text-muted-foreground text-xs"
                data-slot="inventory-quantity-conversion"
              >
                {effectiveMode === "doses"
                  ? t("medications.detail.bestand.quantityInUnits", { units })
                  : // A unit count below one dose must not read "≈ 0 doses" —
                    // it is simply less than one dose.
                    Math.floor(parsed / unitsPerDose) === 0
                    ? t("medications.detail.bestand.quantityUnderOneDose")
                    : t("medications.detail.bestand.quantityInDoses", {
                        doses: Math.floor(parsed / unitsPerDose),
                      })}
              </p>
            )}
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
 * Stock correction for one item: sets the remaining-unit count
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
  const [value, setValue] = useState(String(item.unitsRemaining));
  const [busy, setBusy] = useState(false);

  const parsed = Number(value);
  const valid =
    Number.isInteger(parsed) && parsed >= 0 && parsed <= item.unitsTotal;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    try {
      await apiPatch(`/api/medications/${medicationId}/inventory/${item.id}`, {
        // The wire field carries UNITS (v1.16.10 symmetric naming).
        unitsRemaining: parsed,
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
              max={item.unitsTotal}
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
                total: item.unitsTotal,
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
