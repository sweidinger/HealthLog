"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ChevronDown,
  Eye,
  EyeOff,
  GripVertical,
  Loader2,
  RotateCcw,
} from "lucide-react";
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
import { queryKeys } from "@/lib/query-keys";
import {
  reorderById,
  rebuildTilesWithReorderedVitals,
} from "@/lib/insights-layout-reorder";
import {
  type InsightsLayout,
  type InsightsSectionConfig,
  type InsightsSectionId,
  type InsightsTileConfig,
} from "@/lib/insights-layout";
import {
  MANAGER_GROUP_ORDER,
  SUB_PAGE_MANAGER_GROUP_SLUGS,
  type ManagerGroup,
} from "@/lib/insights/sub-page-metric";
import { SUB_PAGE_TABS } from "@/components/insights/insights-tab-strip";

/**
 * v1.15.11 W3 — inline "Anpassen" edit mode for the customizable Insights
 * overview.
 *
 * Renders LIGHTWEIGHT edit cards (drag handle + localized title + eye toggle)
 * instead of the live, heavy section content, so toggling into edit mode never
 * refetches the section data — it swaps the JSX, not the queries. Edits mutate a
 * local draft; "Fertig" PUTs the merged `{ version: 2, sections, tiles }` blob
 * and invalidates `queryKeys.insightsLayout()`; "Zurücksetzen" DELETEs to
 * defaults.
 *
 * Tile-level depth (the Vitals section's per-metric tiles) ships as the
 * spec-sanctioned DISCLOSURE fallback rather than nested cross-container drag:
 * section rows drag in ONE top-level `SortableContext`; the Vitals row carries a
 * "Kacheln verwalten" disclosure that opens a SEPARATE, independent
 * `DndContext` + `SortableContext` for its tiles. The two drag contexts never
 * share collision detection, so a tile drag can never cross-fire into a section
 * drag — the failure mode flagged in the plan's Risks section. Still inline,
 * still drag + eye per tile, robust on touch.
 */

/** Localized title key per section id — used for the edit-card label. */
const SECTION_TITLE_KEYS: Record<InsightsSectionId, string> = {
  "wellness-scores": "insights.derived.scores.sectionTitle",
  "daily-briefing": "insights.dailyBriefing.title",
  vitals: "insights.derived.vitals.sectionTitle",
  trends: "insights.trendsRow.title",
  "period-review": "insights.narrativeTitle",
  "cycle-summary": "cycle.insightsSummary.title",
  signals: "insights.derived.coincident.cardTitle",
  "rhythm-events": "insights.rhythmEvents.sectionTitle",
};

/**
 * v1.15.14 W2 — group-header label key per manager group. Reuses the
 * tab-strip parent-pill labels (`insights.tabStrip.<group>Parent.label`)
 * so a section header in the manager reads exactly like the nav pill it
 * governs; the three groups the tab strip never collapses (sleep / mood /
 * events) get their own `insights.editMode.group*` keys. ONE source of
 * labels keeps the customize surface and the nav in lockstep.
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

interface InsightsEditModeProps {
  /** Resolved layout currently in effect (server copy, defaults while loading). */
  layout: InsightsLayout;
  /**
   * Which section ids are gated off right now (feature flag / data gate), so
   * the edit row renders disabled with a hint rather than offering a toggle
   * that does nothing.
   */
  gatedOffSectionIds: ReadonlySet<InsightsSectionId>;
  /** Close edit mode (the "Fertig" / save-success path calls this). */
  onClose: () => void;
}

export function InsightsEditMode({
  layout,
  gatedOffSectionIds,
  onClose,
}: InsightsEditModeProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  // Local draft seeded from the resolved layout. Edits mutate the draft only;
  // "Fertig" flushes it via the PUT mutation. Sections/tiles are sorted by
  // order for stable rendering.
  const [draft, setDraft] = useState<InsightsLayout>(() => ({
    version: layout.version,
    sections: [...layout.sections].sort((a, b) => a.order - b.order),
    tiles: [...layout.tiles].sort((a, b) => a.order - b.order),
  }));
  const [tilesOpen, setTilesOpen] = useState(false);

  // v1.15.11 QA L5 — on mount move focus to the edit-card heading so keyboard /
  // screen-reader users land on the surface they just opened (not the top of
  // the document). Inline, not modal, so no focus trap — focus returns to the
  // "Anpassen" toggle on close via the page's onClose handler.
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const saveMutation = useMutation({
    mutationFn: async (next: InsightsLayout) => {
      const res = await fetch("/api/insights/layout", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: 2,
          sections: next.sections,
          tiles: next.tiles,
        }),
      });
      if (!res.ok) throw new Error("save failed");
      return (await res.json()).data as InsightsLayout;
    },
    onSuccess: (saved) => {
      // Optimistic-style settle: write the server-resolved layout into the
      // shared cache so the overview repaints in the new order, then close.
      queryClient.setQueryData(queryKeys.insightsLayout(), saved);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.insightsLayout(),
      });
      toast.success(t("insights.editMode.saveSuccess"));
      onClose();
    },
    onError: () => toast.error(t("insights.editMode.saveError")),
  });

  const resetMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/insights/layout", { method: "DELETE" });
      if (!res.ok) throw new Error("reset failed");
      return (await res.json()).data as InsightsLayout;
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.insightsLayout(), saved);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.insightsLayout(),
      });
      // Re-seed the draft so the open editor reflects the restored defaults.
      setDraft({
        version: saved.version,
        sections: [...saved.sections].sort((a, b) => a.order - b.order),
        tiles: [...saved.tiles].sort((a, b) => a.order - b.order),
      });
      toast.success(t("insights.editMode.resetSuccess"));
    },
    onError: () => toast.error(t("insights.editMode.saveError")),
  });

  const busy = saveMutation.isPending || resetMutation.isPending;

  const sections = useMemo(
    () => [...draft.sections].sort((a, b) => a.order - b.order),
    [draft.sections],
  );
  const sectionIds = sections.map((s) => s.id);

  // v1.15.14 W2 — the manager now lists EVERY sub-page slug grouped by
  // category, not just the Vitals overview grid subset. Each group renders
  // its slugs sorted by the draft's saved `order`; a slug the layout does
  // not enumerate falls to the end. The `overview` tile is layout-only (the
  // mother page, not a sub-page) so it never appears here. Labels reuse the
  // tab-strip `SUB_PAGE_TABS[slug].labelKey` so the manager row reads like
  // the nav pill it governs.
  const tilesByGroup = useMemo(() => {
    const byId = new Map<string, InsightsTileConfig>(
      draft.tiles.map((tt) => [tt.id, tt]),
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
    // Re-derive on any tile change.
  }, [draft.tiles]);

  function toggleSection(id: InsightsSectionId, visible: boolean) {
    setDraft((d) => ({
      ...d,
      sections: d.sections.map((s) => (s.id === id ? { ...s, visible } : s)),
    }));
  }

  function handleSectionDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const reordered = reorderById<InsightsSectionConfig>(
      draft.sections,
      String(active.id),
      String(over.id),
    );
    setDraft((d) => ({ ...d, sections: reordered }));
  }

  function toggleTile(id: string, visible: boolean) {
    setDraft((d) => ({
      ...d,
      tiles: d.tiles.map((tt) => (tt.id === id ? { ...tt, visible } : tt)),
    }));
  }

  /**
   * v1.15.14 W2 — reorder the tiles WITHIN one manager group. Each group
   * renders its own `SortableContext`, so a drag never crosses a group
   * boundary; the group is identified from the dragged slug. We reorder the
   * group's subset through the tested pure helper, then splice it back into
   * the full `tiles` array (which also drives the tab strip + overview grid),
   * re-densifying order only across that group's slots while every other
   * tile keeps its relative order.
   */
  function handleGroupTileDragEnd(group: ManagerGroup, event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const groupRows = tilesByGroup.find((g) => g.group === group)?.rows ?? [];
    const groupMemberIds = new Set(groupRows.map((r) => r.id));
    const subset = groupRows.map((tt) => ({
      id: tt.id,
      order: tt.order,
      visible: tt.visible,
    }));
    // Reorder ONLY this group's subset through the tested pure helper — a
    // single total-order sort, never a mixed-key comparator (QA M2).
    const reordered = reorderById(subset, String(active.id), String(over.id));
    const reorderedIds = reordered.map((r) => r.id);

    setDraft((d) => ({
      ...d,
      // Substitute this group's slots in their new relative order while leaving
      // every other tile untouched. Pure, total-order helper (QA M2).
      tiles: rebuildTilesWithReorderedVitals(d.tiles, reorderedIds, (id) =>
        groupMemberIds.has(id),
      ),
    }));
  }

  const allHidden = draft.sections.every((s) => !s.visible);

  return (
    <div
      data-slot="insights-edit-mode"
      className="bg-card border-border space-y-4 rounded-xl border p-4 sm:p-6"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div>
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-lg font-semibold focus-visible:outline-none"
          >
            {t("insights.editMode.title")}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t("insights.editMode.description")}
          </p>
        </div>
        <div className="flex items-center gap-2 self-end sm:self-auto">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => resetMutation.mutate()}
            disabled={busy}
            data-slot="insights-edit-reset"
          >
            {resetMutation.isPending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            ) : (
              <RotateCcw className="mr-2 h-3.5 w-3.5" />
            )}
            {t("insights.editMode.reset")}
          </Button>
          <Button
            size="sm"
            onClick={() => saveMutation.mutate(draft)}
            disabled={busy}
            data-slot="insights-edit-done"
          >
            {saveMutation.isPending && (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            )}
            {t("insights.editMode.done")}
          </Button>
        </div>
      </div>

      {allHidden && (
        <p
          className="text-muted-foreground text-sm"
          data-slot="insights-edit-all-hidden"
        >
          {t("insights.editMode.allHiddenHint")}
        </p>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleSectionDragEnd}
      >
        <SortableContext
          items={sectionIds}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-2">
            {sections.map((section) => {
              const gatedOff = gatedOffSectionIds.has(section.id);
              const isVitals = section.id === "vitals";
              return (
                <SortableSectionRow
                  key={section.id}
                  section={section}
                  title={t(SECTION_TITLE_KEYS[section.id])}
                  gatedOff={gatedOff}
                  disabled={busy}
                  labels={{
                    dragHandle: t("insights.editMode.dragHandle"),
                    show: t("insights.editMode.show"),
                    hide: t("insights.editMode.hide"),
                    gatedHint: t("insights.editMode.gatedHint"),
                  }}
                  onToggle={toggleSection}
                >
                  {isVitals && (
                    <div className="mt-2 border-t pt-2">
                      <button
                        type="button"
                        onClick={() => setTilesOpen((o) => !o)}
                        disabled={busy}
                        aria-expanded={tilesOpen}
                        data-slot="insights-edit-tiles-disclosure"
                        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 rounded text-sm focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
                      >
                        <ChevronDown
                          className={cn(
                            "h-4 w-4 transition-transform motion-reduce:transition-none",
                            tilesOpen && "rotate-180",
                          )}
                          aria-hidden="true"
                        />
                        {t("insights.editMode.manageSubPages")}
                      </button>
                      {tilesOpen && (
                        // v1.15.14 W2 — the manager now lists EVERY sub-page
                        // slug grouped by category, the same `tiles` layout the
                        // tab strip + overview Vitals grid read. Each group is
                        // its OWN `DndContext` + `SortableContext` so a drag
                        // never crosses a group boundary (and never cross-fires
                        // into the section drag). The whole list scrolls inside
                        // one capped container; `overscroll-contain` keeps the
                        // scroll local on touch.
                        <div className="mt-2 max-h-[60vh] space-y-3 overflow-y-auto overscroll-contain">
                          {tilesByGroup.map(({ group, rows }) => (
                            <div key={group} data-slot="insights-edit-tile-group" data-group={group}>
                              <p className="text-muted-foreground px-1 py-1 text-[11px] font-semibold tracking-wide uppercase">
                                {t(MANAGER_GROUP_HEADER_KEYS[group])}
                              </p>
                              <DndContext
                                sensors={sensors}
                                collisionDetection={closestCenter}
                                onDragEnd={(event) =>
                                  handleGroupTileDragEnd(group, event)
                                }
                              >
                                <SortableContext
                                  items={rows.map((r) => r.id)}
                                  strategy={verticalListSortingStrategy}
                                >
                                  <div className="space-y-1.5">
                                    {rows.map((tile) => (
                                      <SortableTileRow
                                        key={tile.id}
                                        id={tile.id}
                                        title={t(tile.labelKey)}
                                        visible={tile.visible}
                                        disabled={busy}
                                        labels={{
                                          dragHandle: t(
                                            "insights.editMode.dragHandle",
                                          ),
                                          show: t("insights.editMode.show"),
                                          hide: t("insights.editMode.hide"),
                                        }}
                                        onToggle={toggleTile}
                                      />
                                    ))}
                                  </div>
                                </SortableContext>
                              </DndContext>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </SortableSectionRow>
              );
            })}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

interface RowLabels {
  dragHandle: string;
  show: string;
  hide: string;
}

const DRAG_HANDLE_CLASS =
  "text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background relative inline-flex h-11 w-11 shrink-0 cursor-grab touch-none items-center justify-center rounded transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none sm:h-9 sm:w-9 sm:before:absolute sm:before:inset-[-6px] sm:before:content-['']";

function EyeToggle({
  visible,
  disabled,
  label,
  onClick,
  slot,
}: {
  visible: boolean;
  disabled: boolean;
  label: string;
  onClick: () => void;
  slot: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      aria-pressed={visible}
      aria-label={label}
      title={label}
      data-slot={slot}
      data-visible={visible ? "true" : "false"}
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background inline-flex h-11 w-11 shrink-0 items-center justify-center rounded transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none sm:h-9 sm:w-9"
    >
      {visible ? (
        <Eye className="h-4 w-4" />
      ) : (
        <EyeOff className="h-4 w-4" />
      )}
    </button>
  );
}

interface SortableSectionRowProps {
  section: InsightsSectionConfig;
  title: string;
  gatedOff: boolean;
  disabled: boolean;
  labels: RowLabels & { gatedHint: string };
  onToggle: (id: InsightsSectionId, visible: boolean) => void;
  children?: React.ReactNode;
}

function SortableSectionRow({
  section,
  title,
  gatedOff,
  disabled,
  labels,
  onToggle,
  children,
}: SortableSectionRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: section.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: prefersReducedMotion() ? "none" : transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-slot="insights-edit-section-row"
      data-section={section.id}
      data-dragging={isDragging ? "true" : undefined}
      data-gated={gatedOff ? "true" : undefined}
      className={cn(
        "border-border bg-background/30 w-full rounded-md border px-2 py-2 sm:px-3",
        isDragging && "ring-primary z-10 opacity-90 shadow-lg ring-2",
        gatedOff && "opacity-60",
      )}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`${labels.dragHandle} — ${title}`}
          title={labels.dragHandle}
          disabled={disabled}
          data-slot="insights-edit-section-handle"
          className={DRAG_HANDLE_CLASS}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium" title={title}>
            {title}
          </span>
          {/* v1.15.11 QA M1-design — the gated hint reads as a caption BELOW the
              title so the row's right-edge control position stays stable whether
              the section is gated or not. */}
          {gatedOff && (
            <span
              className="text-muted-foreground truncate text-xs"
              data-slot="insights-edit-section-gated-hint"
            >
              {labels.gatedHint}
            </span>
          )}
        </div>
        {/* v1.15.11 QA M1-design — a gated section keeps a DISABLED eye toggle in
            the SAME position rather than swapping it for a text span, so the row
            layout never jumps. The section stays reorderable; only the toggle is
            inert until the gate opens. */}
        <EyeToggle
          visible={section.visible}
          disabled={disabled || gatedOff}
          label={`${section.visible ? labels.hide : labels.show} — ${title}`}
          onClick={() => onToggle(section.id, !section.visible)}
          slot="insights-edit-section-eye"
        />
      </div>
      {children}
    </div>
  );
}

interface SortableTileRowProps {
  id: string;
  title: string;
  visible: boolean;
  disabled: boolean;
  labels: RowLabels;
  onToggle: (id: string, visible: boolean) => void;
}

function SortableTileRow({
  id,
  title,
  visible,
  disabled,
  labels,
  onToggle,
}: SortableTileRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: prefersReducedMotion() ? "none" : transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-slot="insights-edit-tile-row"
      data-tile={id}
      data-dragging={isDragging ? "true" : undefined}
      className={cn(
        "border-border bg-card flex items-center gap-2 rounded-md border px-2 py-1.5",
        isDragging && "ring-primary z-10 opacity-90 shadow-md ring-2",
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`${labels.dragHandle} — ${title}`}
        title={labels.dragHandle}
        disabled={disabled}
        data-slot="insights-edit-tile-handle"
        className={DRAG_HANDLE_CLASS}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="min-w-0 flex-1 truncate text-sm" title={title}>
        {title}
      </span>
      <EyeToggle
        visible={visible}
        disabled={disabled}
        label={`${visible ? labels.hide : labels.show} — ${title}`}
        onClick={() => onToggle(id, !visible)}
        slot="insights-edit-tile-eye"
      />
    </div>
  );
}
