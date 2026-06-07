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
        className="hover:text-foreground inline-flex items-center gap-1 transition-colors"
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
