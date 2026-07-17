"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useTranslations } from "@/lib/i18n/context";
import { apiPost } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

/**
 * v1.29 — manual water quick-add sheet, opened from the hydration card.
 *
 * Chips (+200/+300/+500 mL) fire immediately (mode "add") and keep the
 * sheet open so a run of taps composes one round number; the sheet stays
 * a lightweight stepper, not a form the user has to re-open per tap. The
 * custom-amount field and the "edit today's total" disclosure both close
 * on submit — the two are one-shot actions.
 *
 * Every write hits `POST /api/nutrients/water`, which owns ONLY the
 * `source="MANUAL"` row (migration 0249) — never the Apple-synced row.
 */

const QUICK_CHIPS_ML = [200, 300, 500] as const;

interface WaterQuickAddSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Today's combined (all-source) total, for the "edit total" pre-fill. */
  todayTotalMl: number;
}

export function WaterQuickAddSheet({
  open,
  onOpenChange,
  todayTotalMl,
}: WaterQuickAddSheetProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [customAmount, setCustomAmount] = useState("");
  const [editMode, setEditMode] = useState(false);
  const [editAmount, setEditAmount] = useState(() => String(todayTotalMl));

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["nutrients"] });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.dashboardSnapshot(),
    });
  };

  const addMutation = useMutation({
    mutationFn: (amountMl: number) =>
      apiPost("/api/nutrients/water", { amountMl, mode: "add" as const }),
    onSuccess: invalidate,
    onError: () => toast.error(t("nutrients.hydration.quickAddError")),
  });

  const setMutation = useMutation({
    mutationFn: (amountMl: number) =>
      apiPost("/api/nutrients/water", { amountMl, mode: "set" as const }),
    onSuccess: () => {
      invalidate();
      setEditMode(false);
      onOpenChange(false);
    },
    onError: () => toast.error(t("nutrients.hydration.quickAddError")),
  });

  const handleCustomAdd = () => {
    const amount = Number(customAmount);
    if (!Number.isFinite(amount) || amount <= 0) return;
    addMutation.mutate(amount);
    setCustomAmount("");
    onOpenChange(false);
  };

  const handleEditSave = () => {
    const amount = Number(editAmount);
    if (!Number.isFinite(amount) || amount < 0) return;
    setMutation.mutate(amount);
  };

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("nutrients.hydration.quickAddTitle")}
    >
      <div className="flex flex-wrap gap-2" data-slot="water-quick-add-chips">
        {QUICK_CHIPS_ML.map((amountMl) => (
          <Button
            key={amountMl}
            type="button"
            variant="outline"
            size="sm"
            disabled={addMutation.isPending}
            onClick={() => {
              addMutation.mutate(amountMl);
              toast.success(`+${amountMl} mL`);
            }}
          >
            +{amountMl} mL
          </Button>
        ))}
      </div>

      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="water-custom-amount">
            {t("nutrients.hydration.quickAddCustomLabel")}
          </Label>
          <Input
            id="water-custom-amount"
            type="number"
            inputMode="numeric"
            min={1}
            max={20000}
            placeholder={t("nutrients.hydration.quickAddCustomPlaceholder")}
            value={customAmount}
            onChange={(e) => setCustomAmount(e.target.value)}
          />
        </div>
        <Button
          type="button"
          onClick={handleCustomAdd}
          disabled={addMutation.isPending || !customAmount}
        >
          {t("nutrients.hydration.quickAddSubmit")}
        </Button>
      </div>

      {editMode ? (
        <div className="border-border/70 space-y-1.5 border-t pt-4">
          <Label htmlFor="water-edit-total">
            {t("nutrients.hydration.editTotal")}
          </Label>
          <div className="flex items-end gap-2">
            <Input
              id="water-edit-total"
              type="number"
              inputMode="numeric"
              min={0}
              max={20000}
              className="flex-1"
              value={editAmount}
              onChange={(e) => setEditAmount(e.target.value)}
            />
            <Button
              type="button"
              onClick={handleEditSave}
              disabled={setMutation.isPending}
            >
              {t("nutrients.hydration.quickAddSubmit")}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground self-start"
          onClick={() => {
            setEditAmount(String(todayTotalMl));
            setEditMode(true);
          }}
        >
          {t("nutrients.hydration.editTotal")}
        </Button>
      )}
    </ResponsiveSheet>
  );
}
