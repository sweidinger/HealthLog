import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * v1.17.1 — loading placeholder that mirrors {@link DeviceScoreTile}'s
 * layout so the device-score grids (recovery + sleep-quality) and the lab
 * list paint the same tile shape while their analytics slice loads, instead
 * of popping in or showing a bespoke centred spinner. One header row (title +
 * latest readout) over a sparkline block, all via the shared `Skeleton`
 * primitive (which carries `motion-reduce:animate-none` for free).
 */
export function DeviceScoreTileSkeleton() {
  return (
    <Card data-slot="device-score-tile-skeleton" aria-hidden="true">
      <CardHeader>
        <Skeleton className="h-4 w-32" />
        <CardAction>
          <Skeleton className="h-5 w-12" />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <Skeleton className="h-[120px] w-full" />
        <Skeleton className="h-3 w-24" />
      </CardContent>
    </Card>
  );
}

/**
 * A `count`-wide grid of {@link DeviceScoreTileSkeleton}s, matching the
 * `grid gap-4 sm:grid-cols-2` the device-score sections render their tiles in.
 */
export function DeviceScoreGridSkeleton({ count = 2 }: { count?: number }) {
  return (
    <div
      data-slot="device-score-grid-skeleton"
      className="grid gap-4 sm:grid-cols-2"
    >
      {Array.from({ length: count }, (_, i) => (
        <DeviceScoreTileSkeleton key={i} />
      ))}
    </div>
  );
}
