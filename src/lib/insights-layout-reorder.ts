/**
 * v1.15.11 W3 — pure reorder helper for the inline Insights edit mode.
 *
 * Mirrors the `reorderWidgets` contract in
 * `src/components/settings/dashboard-layout-section.tsx` (move an item from
 * `fromId` next to `toId`, renumber the whole list to a dense 0-based
 * `order`) but is generic over any `{ id, order }` row so the section list
 * AND the Vitals tile sub-list can both reorder through one tested helper.
 *
 * Kept as a standalone module (not imported from the dashboard component) so
 * the inline-edit surface does not depend on a Settings component, and so the
 * helper is unit-testable without spinning up a `DndContext`. The dashboard's
 * own `reorderWidgets` stays untouched — extracting it there would have
 * touched the stable dashboard surface for no behavioural gain.
 */
export interface OrderableRow {
  id: string;
  order: number;
}

/**
 * Move the row identified by `fromId` to the position of `toId`, then
 * renumber every row to a dense 0-based `order`. Returns a NEW array of NEW
 * row objects (every input field is preserved via the spread); the input is
 * never mutated. A no-op move (same id, or either id missing) still returns a
 * densely-renumbered copy so the caller can treat the output as canonical.
 */
export function reorderById<T extends OrderableRow>(
  rows: readonly T[],
  fromId: string,
  toId: string,
): T[] {
  const sorted = [...rows].sort((a, b) => a.order - b.order);
  const fromIdx = sorted.findIndex((r) => r.id === fromId);
  const toIdx = sorted.findIndex((r) => r.id === toId);
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) {
    return sorted.map((r, i) => ({ ...r, order: i }));
  }
  const next = [...sorted];
  const [removed] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, removed);
  return next.map((r, i) => ({ ...r, order: i }));
}
