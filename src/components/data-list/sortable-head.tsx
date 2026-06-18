"use client";

import { ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";

import { TableHead } from "@/components/ui/table";

/**
 * Shared clickable sort header for the data-management tables
 * (measurements + mood). Lifted verbatim from the two copy-pasted
 * `SortableHead` definitions (v1.15.13). Domain specifics — which
 * columns are sortable, their labels — stay in each list; only this
 * chrome moves.
 */
export function SortableHead({
  column,
  label,
  currentSort,
  currentDir,
  onSort,
  className,
}: {
  column: string;
  label: string;
  currentSort: string;
  currentDir: "asc" | "desc";
  onSort: (col: string) => void;
  className?: string;
}) {
  const isActive = currentSort === column;
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className="hover:text-foreground focus-visible:ring-ring/50 inline-flex min-h-11 items-center gap-1 rounded-sm transition-colors focus-visible:ring-2 focus-visible:outline-none sm:min-h-0"
      >
        {label}
        {isActive ? (
          currentDir === "asc" ? (
            <ArrowUp className="h-3.5 w-3.5" />
          ) : (
            <ArrowDown className="h-3.5 w-3.5" />
          )
        ) : (
          <ArrowUpDown className="h-3.5 w-3.5 opacity-40" />
        )}
      </button>
    </TableHead>
  );
}
