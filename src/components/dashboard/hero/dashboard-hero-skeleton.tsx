import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading silhouette for the dashboard hero band.
 *
 * Mirrors the real `<DashboardHero>` footprint exactly — same
 * `.hero-gradient` chrome, same `min-h-[8.75rem] md:min-h-[9.5rem]`
 * floor, same two-column `md:flex-row` split with the fixed 120 px ring
 * circle on the right — so the swap to the loaded hero happens in place
 * with zero layout shift. The left column reserves the greeting line,
 * the verdict sentence + CTA row, and the dose-row pill.
 *
 * Always `aria-hidden` with no focusable content: the tile-strip
 * skeleton alongside carries the page's loading semantics, and a second
 * announcement here would double up for screen readers. Reduced motion
 * is honoured inside the `<Skeleton>` primitive
 * (`motion-reduce:animate-none`).
 */
export function DashboardHeroSkeleton() {
  return (
    <div
      aria-hidden="true"
      data-slot="dashboard-hero-skeleton"
      className="hero-gradient relative isolate min-h-[8.75rem] overflow-hidden rounded-xl px-4 py-5 sm:px-6 md:min-h-[9.5rem]"
    >
      <div className="flex h-full flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0 flex-1 space-y-3">
          {/* Greeting line. */}
          <Skeleton className="h-4 w-48 max-w-full" />
          {/* Verdict sentence + CTA slot. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Skeleton className="h-5 w-72 max-w-full" />
            <Skeleton className="h-8 w-32" />
          </div>
          {/* Dose-row pill. */}
          <Skeleton className="h-9 w-64 max-w-full rounded-xl" />
        </div>
        {/* Fixed right column — the ScoreRing's `sm` circle (120 px). */}
        <div className="flex shrink-0 items-center justify-center md:justify-end">
          <Skeleton className="size-[120px] rounded-full" />
        </div>
      </div>
    </div>
  );
}
