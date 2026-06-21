"use client";

import { useAuth } from "@/hooks/use-auth";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "@/lib/i18n/context";
import { useSleepRhythm } from "./use-sleep-rhythm";
import { AverageSleepCard } from "./average-sleep-card";

/**
 * v1.19.1 — average-sleep-per-night card on the Sleep view.
 *
 * The third peer of `<SleepRhythmSection>` (sleep debt) + `<ChronotypeSection>`
 * in the shared grid row. Reads the SAME server-authoritative DTO via
 * `useSleepRhythm`, so it shares the `["sleep-rhythm"]` cache the siblings
 * already warmed — no extra round-trip. Gated on `enabled` so a source-less
 * account never fetches.
 *
 * States mirror the sibling sections: loading → skeleton, error → quiet inline
 * notice, settled → the card (which carries its own calm "still learning" copy
 * for the no-nights-yet case, since the route always returns a full DTO).
 */
export function AverageSleepSection({ enabled }: { enabled: boolean }) {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();
  const { data, isLoading, isError } = useSleepRhythm(
    isAuthenticated && enabled,
  );

  if (!enabled) return null;

  if (isError) {
    return (
      <div
        data-slot="average-sleep-error"
        role="status"
        className="bg-card border-border text-muted-foreground rounded-xl border p-4 text-sm"
      >
        {t("insights.sleep.rhythm.loadError")}
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <Skeleton
        data-slot="average-sleep-loading"
        className="h-28 w-full rounded-xl"
      />
    );
  }

  return <AverageSleepCard average={data.averagePerNight} />;
}
