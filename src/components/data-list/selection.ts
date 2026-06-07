/**
 * Pure, framework-free selection math for the page-scoped multi-select on
 * the measurements + mood management lists (v1.15.13).
 *
 * Selection is scoped to the CURRENT PAGE per the v1.15.x list audit
 * (§E) — no "select across 200k rows". Every helper here operates on a
 * `Set<string>` of row ids that all belong to the rows currently painted,
 * so the math stays a few cheap set operations regardless of total count.
 *
 * Extracted so the selection logic is unit-testable without a DOM /
 * React render (`selection.test.ts`).
 */

/** Toggle a single id in/out of the selection set, returning a new Set. */
export function toggleId(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Header "select all on this page" state.
 *
 * - `"all"` — every selectable id on the page is selected.
 * - `"some"` — at least one but not all are selected (indeterminate).
 * - `"none"` — nothing on the page is selected.
 *
 * A page with no selectable rows is `"none"` (the header checkbox should
 * be a no-op then).
 */
export type SelectAllState = "all" | "some" | "none";

export function selectAllState(
  selected: ReadonlySet<string>,
  pageIds: readonly string[],
): SelectAllState {
  if (pageIds.length === 0) return "none";
  let selectedOnPage = 0;
  for (const id of pageIds) {
    if (selected.has(id)) selectedOnPage += 1;
  }
  if (selectedOnPage === 0) return "none";
  if (selectedOnPage === pageIds.length) return "all";
  return "some";
}

/**
 * Apply a "select all on page" toggle. When every selectable id on the
 * page is already selected, the toggle clears the page's ids; otherwise it
 * adds the page's ids to the existing selection. Selection from other
 * (now-unmounted) pages is dropped on a page change by the caller, so in
 * practice `selected` only ever holds current-page ids — but this stays
 * correct either way.
 */
export function toggleSelectAll(
  selected: ReadonlySet<string>,
  pageIds: readonly string[],
): Set<string> {
  if (pageIds.length === 0) return new Set(selected);
  const allSelected = pageIds.every((id) => selected.has(id));
  const next = new Set(selected);
  if (allSelected) {
    for (const id of pageIds) next.delete(id);
  } else {
    for (const id of pageIds) next.add(id);
  }
  return next;
}

/**
 * The selected ids intersected with the ids actually present on the page.
 * The bulk-delete request only ever sends rows the user can currently see,
 * which keeps the payload page-bounded (≤ PAGE_SIZE) and matches the
 * server's 200-id cap with room to spare.
 */
export function selectedIdsOnPage(
  selected: ReadonlySet<string>,
  pageIds: readonly string[],
): string[] {
  return pageIds.filter((id) => selected.has(id));
}

/** Count of selected ids that are present on the current page. */
export function selectedCountOnPage(
  selected: ReadonlySet<string>,
  pageIds: readonly string[],
): number {
  let n = 0;
  for (const id of pageIds) {
    if (selected.has(id)) n += 1;
  }
  return n;
}
