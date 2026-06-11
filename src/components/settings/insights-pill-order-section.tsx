"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Eye, EyeOff, GripVertical, Loader2 } from "lucide-react";
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

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { useTranslations } from "@/lib/i18n/context";
import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { useInsightsLayoutQuery } from "@/hooks/use-insights-layout";
import {
  reorderById,
  rebuildTilesWithReorderedVitals,
} from "@/lib/insights-layout-reorder";
import {
  type InsightsLayout,
  type InsightsTileConfig,
} from "@/lib/insights-layout";
import {
  MANAGER_GROUP_ORDER,
  SUB_PAGE_MANAGER_GROUP_SLUGS,
  type ManagerGroup,
} from "@/lib/insights/sub-page-metric";
import { SUB_PAGE_TABS } from "@/components/insights/insights-tab-strip";
import { apiPut } from "@/lib/api/api-fetch";

/**
 * v1.15.18 — dedicated pill-sort control for the Insights settings section.
 * v1.15.20 — pill VISIBILITY joins the same list: each row carries the eye
 * toggle the overview edit cards use, flipping `tiles[].visible` (the field
 * that already gates both the top-nav pill and the overview Vitals grid since
 * v1.15.14). Sorting and show/hide for the detail pages live on ONE surface;
 * the on-page edit mode's former "Manage detail pages" disclosure retired in
 * favour of a link here.
 *
 * The Insights nav PILLS persist to `insightsLayoutJson.tiles[].order`, a field
 * that is ALREADY separate from the overview `sections[].order` in layout v2.
 * Until v1.15.18 the pill order could only be changed implicitly through the
 * overview "Anpassen" → "Kacheln verwalten" disclosure (the Vitals row), which
 * the maintainer found unintuitive. This is the explicit surface: drag the
 * pills, toggle their eyes, "Speichern" PUTs the merged `{ tiles }` blob to
 * `/api/insights/layout`, which the tab strip + overview share via
 * `queryKeys.insightsLayout()`.
 *
 * Drag mirrors `insights-edit-mode` — each manager group is its OWN
 * `DndContext` + `SortableContext` so a drag never crosses a group boundary.
 */

const MANAGER_GROUP_HEADER_KEYS: Record<ManagerGroup, string> = {
  vitals: "insights.tabStrip.vitalsParent.label",
  body: "insights.tabStrip.bodyParent.label",
  activity: "insights.tabStrip.activityParent.label",
  sleep: "insights.editMode.groupSleep",
  cardiovascular: "insights.tabStrip.cardiovascularParent.label",
  hearing: "insights.tabStrip.hearingParent.label",
  environment: "insights.tabStrip.environmentParent.label",
  metabolic: "insights.tabStrip.metabolicParent.label",
  mood: "insights.editMode.groupMood",
  events: "insights.editMode.groupEvents",
};

/**
 * Stable fingerprint used to detect when the server copy changed. Carries
 * both the id order AND each tile's visibility so a save that only flipped
 * an eye still re-seeds the draft baseline.
 */
function layoutSignature(tiles: readonly InsightsTileConfig[]): string {
  return [...tiles]
    .sort((a, b) => a.order - b.order)
    .map((tile) => `${tile.id}:${tile.visible ? 1 : 0}`)
    .join(",");
}

export function InsightsPillOrderSection({ id }: { id?: string }) {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const { layout, isLoading, isSuccess } =
    useInsightsLayoutQuery(isAuthenticated);

  // Local draft of the tiles, seeded from the resolved layout and re-seeded in
  // render (the React-sanctioned "adjust state on prop change" pattern, no
  // effect) whenever the server copy's id-order changes — e.g. after a save or
  // once the GET settles. Tracking the last-seeded signature in STATE (not a
  // ref) keeps the reseed render-safe and idempotent while leaving in-flight
  // drag edits untouched: the baseline only advances when the *server* order
  // differs from what we last seeded from.
  const serverSignature = layoutSignature(layout.tiles);
  const [seededSignature, setSeededSignature] = useState(serverSignature);
  const [draftTiles, setDraftTiles] = useState<InsightsTileConfig[]>(() =>
    [...layout.tiles].sort((a, b) => a.order - b.order),
  );
  if (isSuccess && serverSignature !== seededSignature) {
    setSeededSignature(serverSignature);
    setDraftTiles([...layout.tiles].sort((a, b) => a.order - b.order));
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const saveMutation = useMutation({
    mutationFn: async (tiles: InsightsTileConfig[]) => {
      return apiPut<InsightsLayout>("/api/insights/layout", {
        version: 2,
        // Preserve the overview section order/visibility verbatim — this
        // surface owns the PILL order only.
        sections: layout.sections,
        tiles,
      });
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.insightsLayout(), saved);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.insightsLayout(),
      });
      toast.success(t("insights.pillOrder.saveSuccess"));
    },
    onError: () => toast.error(t("insights.pillOrder.saveError")),
  });

  const busy = saveMutation.isPending;

  // Group the draft tiles the same way the tab strip + manager do, so each
  // group's pills sort within their own `SortableContext`.
  const tilesByGroup = useMemo(() => {
    const byId = new Map<string, InsightsTileConfig>(
      draftTiles.map((tile) => [tile.id, tile]),
    );
    return MANAGER_GROUP_ORDER.map((group) => {
      const rows = SUB_PAGE_MANAGER_GROUP_SLUGS[group]
        .map((slug) => {
          const cfg = byId.get(slug);
          return {
            id: slug as string,
            labelKey: SUB_PAGE_TABS[slug].labelKey,
            visible: cfg?.visible ?? false,
            order: cfg?.order ?? Number.MAX_SAFE_INTEGER,
          };
        })
        .sort((a, b) => a.order - b.order);
      return { group, rows };
    }).filter((g) => g.rows.length > 0);
  }, [draftTiles]);

  function handleGroupDragEnd(group: ManagerGroup, event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const groupRows = tilesByGroup.find((g) => g.group === group)?.rows ?? [];
    const groupMemberIds = new Set(groupRows.map((r) => r.id));
    const subset = groupRows.map((r) => ({ id: r.id, order: r.order }));
    const reordered = reorderById(subset, String(active.id), String(over.id));
    const reorderedIds = reordered.map((r) => r.id);

    // Substitute this group's slots in their new relative order through the
    // same tested, total-order helper the inline edit mode uses, leaving every
    // other tile's relative order untouched (QA M2).
    setDraftTiles((tiles) =>
      rebuildTilesWithReorderedVitals(tiles, reorderedIds, (id) =>
        groupMemberIds.has(id),
      ),
    );
  }

  /**
   * Flip one tile's visibility in the draft. Persisted on "Speichern" through
   * the same `{ tiles }` PUT as the order — `tiles[].visible` is the field the
   * tab strip and the overview Vitals grid already read (v1.15.14).
   */
  function toggleTileVisible(id: string, visible: boolean) {
    setDraftTiles((tiles) =>
      tiles.map((tile) => (tile.id === id ? { ...tile, visible } : tile)),
    );
  }

  const dirty = useMemo(
    () => layoutSignature(layout.tiles) !== layoutSignature(draftTiles),
    [layout.tiles, draftTiles],
  );

  return (
    <section
      id={id}
      data-slot="insights-pill-order-section"
      aria-labelledby="insights-pill-order-title"
      className="bg-card border-border space-y-4 rounded-xl border p-4 sm:p-6"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div className="space-y-1">
          <h2 id="insights-pill-order-title" className="text-lg font-semibold">
            {t("insights.pillOrder.title")}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t("insights.pillOrder.description")}
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => saveMutation.mutate(draftTiles)}
          disabled={busy || !dirty}
          data-slot="insights-pill-order-save"
          className="self-end sm:self-auto"
        >
          {saveMutation.isPending && (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          )}
          {t("insights.pillOrder.save")}
        </Button>
      </div>

      {isLoading ? (
        <p
          className="text-muted-foreground text-sm"
          data-slot="insights-pill-order-loading"
        >
          <Loader2 className="mr-2 inline h-3.5 w-3.5 animate-spin align-text-bottom motion-reduce:animate-none" />
        </p>
      ) : tilesByGroup.length === 0 ? (
        <p
          className="text-muted-foreground text-sm"
          data-slot="insights-pill-order-empty"
        >
          {t("insights.pillOrder.empty")}
        </p>
      ) : (
        <div className="max-h-[60vh] space-y-3 overflow-y-auto overscroll-contain">
          {tilesByGroup.map(({ group, rows }) => (
            <div
              key={group}
              data-slot="insights-pill-order-group"
              data-group={group}
            >
              <p className="text-muted-foreground px-1 py-1 text-[11px] font-semibold tracking-wide uppercase">
                {t(MANAGER_GROUP_HEADER_KEYS[group])}
              </p>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={(event) => handleGroupDragEnd(group, event)}
              >
                <SortableContext
                  items={rows.map((r) => r.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-1.5">
                    {rows.map((tile) => (
                      <SortablePillRow
                        key={tile.id}
                        id={tile.id}
                        title={t(tile.labelKey)}
                        visible={tile.visible}
                        disabled={busy}
                        dragHandleLabel={t("insights.pillOrder.dragHandle")}
                        showLabel={t("insights.editMode.show")}
                        hideLabel={t("insights.editMode.hide")}
                        onToggle={toggleTileVisible}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const DRAG_HANDLE_CLASS =
  "text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background relative inline-flex h-11 w-11 shrink-0 cursor-grab touch-none items-center justify-center rounded transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none sm:h-9 sm:w-9 sm:before:absolute sm:before:inset-[-6px] sm:before:content-['']";

function SortablePillRow({
  id,
  title,
  visible,
  disabled,
  dragHandleLabel,
  showLabel,
  hideLabel,
  onToggle,
}: {
  id: string;
  title: string;
  visible: boolean;
  disabled: boolean;
  dragHandleLabel: string;
  showLabel: string;
  hideLabel: string;
  onToggle: (id: string, visible: boolean) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: prefersReducedMotion() ? "none" : transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-slot="insights-pill-order-row"
      data-tile={id}
      data-dragging={isDragging ? "true" : undefined}
      className={cn(
        "border-border bg-background/30 flex items-center gap-2 rounded-md border px-2 py-1.5",
        isDragging && "ring-primary z-10 opacity-90 shadow-md ring-2",
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`${dragHandleLabel} — ${title}`}
        title={dragHandleLabel}
        disabled={disabled}
        data-slot="insights-pill-order-handle"
        className={DRAG_HANDLE_CLASS}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="min-w-0 flex-1 truncate text-sm" title={title}>
        {title}
      </span>
      {/* v1.15.20 — same eye interaction as the overview edit cards: the
          toggle flips the draft's `visible` flag; "Speichern" persists it. */}
      <button
        type="button"
        onClick={() => onToggle(id, !visible)}
        disabled={disabled}
        aria-pressed={visible}
        aria-label={`${visible ? hideLabel : showLabel} — ${title}`}
        title={visible ? hideLabel : showLabel}
        data-slot="insights-pill-order-eye"
        data-visible={visible ? "true" : "false"}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background inline-flex h-11 w-11 shrink-0 items-center justify-center rounded transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none sm:h-9 sm:w-9"
      >
        {visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
      </button>
    </div>
  );
}
