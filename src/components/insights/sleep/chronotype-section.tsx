"use client";

import { useAuth } from "@/hooks/use-auth";
import { Skeleton } from "@/components/ui/skeleton";
import { useSleepRhythm } from "./use-sleep-rhythm";
import { ChronotypeCard } from "./chronotype-card";

/**
 * v1.18.7 W-D — chronotype card on the Sleep view.
 *
 * v1.19.0 — the standalone "Chronotyp" `<SectionHeading>` was removed: it
 * duplicated the heading the `<ChronotypeCard>` already carries in its own
 * `CardTitle`, so "Chronotype" appeared twice and the tile no longer matched
 * its sibling (the sleep-debt tile, which has no section heading). The card now
 * stands as a peer of `<SleepDebtCard>` inside the shared grid row — same card
 * chrome, one heading each, rendered inside the tile.
 *
 * Reads the SAME server-authoritative DTO via `useSleepRhythm`, so it shares the
 * `["sleep-rhythm"]` cache the debt section already warmed — no extra
 * round-trip. Gated on `enabled` so a source-less account never fetches.
 *
 * States mirror the debt section: loading → skeleton, error → quiet inline
 * notice, settled → the card (which carries its own calm "still learning" copy
 * for the no-nights-yet case, since the route always returns a full DTO).
 */
export function ChronotypeSection({ enabled }: { enabled: boolean }) {
  const { isAuthenticated } = useAuth();
  const { data, isLoading } = useSleepRhythm(isAuthenticated && enabled);

  if (!enabled) return null;

  if (isLoading || !data) {
    return (
      <Skeleton
        data-slot="chronotype-loading"
        className="h-32 w-full rounded-xl"
      />
    );
  }

  return <ChronotypeCard chronotype={data.chronotype} />;
}
