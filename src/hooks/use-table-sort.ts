"use client";

import { useCallback, useState } from "react";

export type SortDirection = "asc" | "desc";

/**
 * Shared column-sort state for the data-management tables (measurements,
 * mood, lab history). Lifted from the byte-identical `sortBy` / `sortDir` /
 * `toggleSort` triple the measurement + mood lists each carried inline.
 *
 * `toggleSort(column)` flips the direction when the active column is tapped
 * again, otherwise switches to the new column with its default direction:
 * a column listed in `descColumns` (typically the date column) opens
 * descending, every other column ascending. Callers that need extra side
 * effects on a sort change (reset the page, clear a selection) compose them
 * around the returned `toggleSort` rather than re-implementing the math.
 */
export function useTableSort({
  defaultColumn,
  defaultDir = "desc",
  descColumns,
}: {
  /** Column the table sorts by on first render. */
  defaultColumn: string;
  /** Direction for the initial column. */
  defaultDir?: SortDirection;
  /** Columns that open descending when first selected (e.g. the date column). */
  descColumns?: ReadonlySet<string>;
}): {
  sortBy: string;
  sortDir: SortDirection;
  toggleSort: (column: string) => void;
} {
  const [sortBy, setSortBy] = useState<string>(defaultColumn);
  const [sortDir, setSortDir] = useState<SortDirection>(defaultDir);

  const toggleSort = useCallback(
    (column: string) => {
      if (sortBy === column) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortBy(column);
        setSortDir(descColumns?.has(column) ? "desc" : "asc");
      }
    },
    [sortBy, descColumns],
  );

  return { sortBy, sortDir, toggleSort };
}
