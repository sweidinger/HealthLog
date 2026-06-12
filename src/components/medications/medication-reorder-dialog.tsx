"use client";

import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, GripVertical, Loader2 } from "lucide-react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { reorderById } from "@/lib/insights-layout-reorder";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { useTranslations } from "@/lib/i18n/context";
import { runSaveMedicationListOrder } from "@/lib/queries/use-medication-list-layout";

/**
 * v1.16.10 — manual medication ordering, shared by BOTH /medications
 * views (cards + table). Reuses the dashboard / insights reorder
 * vocabulary: a vertical row list with a drag handle (@dnd-kit, pointer
 * + keyboard sensors) AND per-row up/down arrow buttons as the primary
 * keyboard surface, flushed by an explicit Save. The swap-and-renumber
 * logic is the shared `reorderById` helper the inline Insights edit
 * mode rides (the standalone extraction of the dashboard's
 * `reorderWidgets` contract), so the surfaces cannot drift.
 *
 * The dialog edits a draft of the full medication list (active first,
 * inactive after — matching the page's render grouping); Save persists
 * the id order through `PUT /api/medications/layout` (order-only, the
 * stored view is preserved server-side).
 */

export interface ReorderMedication {
  id: string;
  name: string;
  dose: string;
  active: boolean;
}

interface MedicationReorderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The full list in its current effective order (active block first). */
  medications: ReorderMedication[];
}

export function MedicationReorderDialog({
  open,
  onOpenChange,
  medications,
}: MedicationReorderDialogProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const dragHintId = useId();
  const [saving, setSaving] = useState(false);
  // Draft id order — null means "the order the page passed in". Created
  // on the first move so an untouched dialog can cancel without churn.
  const [draft, setDraft] = useState<string[] | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const byId = new Map(medications.map((m) => [m.id, m]));
  const ids =
    draft ?? medications.map((m) => m.id);
  const rows = ids
    .map((id) => byId.get(id))
    .filter((m): m is ReorderMedication => m !== undefined);

  function applyReorder(fromId: string, toId: string) {
    const reordered = reorderById(
      ids.map((id, order) => ({ id, order })),
      fromId,
      toId,
    );
    setDraft(reordered.map((r) => r.id));
  }

  function move(id: string, delta: -1 | 1) {
    const idx = ids.indexOf(id);
    const targetIdx = idx + delta;
    if (idx < 0 || targetIdx < 0 || targetIdx >= ids.length) return;
    applyReorder(id, ids[targetIdx]);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    applyReorder(String(active.id), String(over.id));
  }

  async function save() {
    setSaving(true);
    const ok = await runSaveMedicationListOrder({
      order: ids,
      queryClient,
      t,
    });
    setSaving(false);
    if (ok) {
      setDraft(null);
      onOpenChange(false);
    }
  }

  function close(next: boolean) {
    if (!next) setDraft(null);
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("medications.reorderTitle")}</DialogTitle>
          <DialogDescription>
            {t("medications.reorderDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              {rows.map((med, index) => (
                <SortableMedicationRow
                  key={med.id}
                  medication={med}
                  index={index}
                  total={rows.length}
                  dragHintId={dragHintId}
                  disabled={saving}
                  labels={{
                    moveUp: t("dashboard.moveUp"),
                    moveDown: t("dashboard.moveDown"),
                    dragHandle: t("dashboard.dragHandle"),
                    inactive: t("common.inactive"),
                  }}
                  onMove={move}
                />
              ))}
            </SortableContext>
          </DndContext>
          {rows.length > 0 && (
            <p id={dragHintId} className="text-muted-foreground sr-only">
              {t("dashboard.dragHandleHint")}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => close(false)}
            disabled={saving}
          >
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void save()} disabled={saving || !draft}>
            {saving && (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            )}
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface SortableMedicationRowProps {
  medication: ReorderMedication;
  index: number;
  total: number;
  dragHintId: string;
  disabled: boolean;
  labels: {
    moveUp: string;
    moveDown: string;
    dragHandle: string;
    inactive: string;
  };
  onMove: (id: string, delta: -1 | 1) => void;
}

function SortableMedicationRow({
  medication,
  index,
  total,
  dragHintId,
  disabled,
  labels,
  onMove,
}: SortableMedicationRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: medication.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: prefersReducedMotion() ? "none" : transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-slot="medication-reorder-row"
      data-dragging={isDragging ? "true" : undefined}
      className={`border-border bg-background/30 flex min-h-12 items-center gap-2 rounded-md border px-3 py-2 ${
        isDragging ? "ring-primary z-10 opacity-90 shadow-lg ring-2" : ""
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`${labels.dragHandle} — ${medication.name}`}
        aria-describedby={dragHintId}
        title={labels.dragHandle}
        disabled={disabled}
        data-slot="medication-drag-handle"
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background relative -m-1 inline-flex h-7 w-7 cursor-grab touch-none items-center justify-center rounded transition-colors before:absolute before:inset-[-8px] before:content-[''] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="min-w-0 flex-1 text-sm">
        <span className="block truncate font-medium" title={medication.name}>
          {medication.name}
        </span>
        <span className="text-muted-foreground block truncate text-xs">
          {medication.dose}
          {!medication.active && <> · {labels.inactive}</>}
        </span>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 sm:size-9"
        onClick={() => onMove(medication.id, -1)}
        disabled={index === 0 || disabled}
        aria-label={`${labels.moveUp} — ${medication.name}`}
      >
        <ArrowUp className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 sm:size-9"
        onClick={() => onMove(medication.id, 1)}
        disabled={index === total - 1 || disabled}
        aria-label={`${labels.moveDown} — ${medication.name}`}
      >
        <ArrowDown className="h-4 w-4" />
      </Button>
    </div>
  );
}
