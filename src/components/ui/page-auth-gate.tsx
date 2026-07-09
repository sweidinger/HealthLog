import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Auth-resolving placeholder for a top-level page.
 *
 * Every module page renders while `useAuth()` / its first query settles. The
 * legacy pattern was a lone centered `Loader2` that then snapped into the full
 * layout — a reflow, and inconsistent with the skeleton-first surfaces
 * (documents, Insights tiles, dashboard hero). This reserves the page frame
 * instead: a `PageHeader`-shaped title/description block above a tile grid, so
 * the auth-resolving frame holds the same geometry the loaded page will.
 *
 * Presentational + `aria-hidden` (matching the old spinner, which announced
 * nothing); pass `label` to expose an `sr-only` status line for screen readers.
 */
export function PageAuthGate({
  className,
  label,
  tiles = 3,
}: {
  className?: string;
  label?: string;
  /** Number of content tile skeletons below the header. */
  tiles?: number;
}) {
  return (
    <div
      data-slot="page-auth-gate"
      className={cn("space-y-6", className)}
      aria-hidden="true"
    >
      {label ? (
        <span className="sr-only" aria-live="polite" aria-hidden={false}>
          {label}
        </span>
      ) : null}
      <div className="space-y-1.5">
        <Skeleton className="h-8 w-48 max-w-full rounded" />
        <Skeleton className="h-4 w-72 max-w-full rounded" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: tiles }).map((_, i) => (
          <Skeleton key={i} className="h-32 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
