"use client";

import { useAuth } from "@/hooks/use-auth";
import { Skeleton } from "@/components/ui/skeleton";
import { useSleepRhythm } from "./use-sleep-rhythm";
import { SleepDebtCard } from "./sleep-debt-card";
import { ChronotypeCard } from "./chronotype-card";

/**
 * v1.17.0 — sleep-rhythm section on the Sleep page.
 *
 * Reads the server-authoritative sleep-debt + chronotype DTO and renders the
 * sleep-debt headline + the chronotype card. Gated on `enabled` so a
 * source-less account never fetches. The values are identical to what the iOS
 * client renders (one server computation).
 */
export function SleepRhythmSection({ enabled }: { enabled: boolean }) {
  const { isAuthenticated } = useAuth();
  const { data, isLoading } = useSleepRhythm(isAuthenticated && enabled);

  if (!enabled) return null;

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-28 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SleepDebtCard debt={data.sleepDebt} />
      <ChronotypeCard chronotype={data.chronotype} />
    </div>
  );
}
