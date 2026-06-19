"use client";

import { useAuth } from "@/hooks/use-auth";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "@/lib/i18n/context";
import { useSleepRhythm } from "./use-sleep-rhythm";
import { SleepDebtCard } from "./sleep-debt-card";

/**
 * v1.17.0 — sleep-rhythm section on the Sleep page.
 *
 * Reads the server-authoritative sleep-debt + chronotype DTO and renders the
 * sleep-debt headline. Gated on `enabled` so a source-less account never
 * fetches. The values are identical to what the iOS client renders (one server
 * computation).
 *
 * v1.18.7 W-D — the chronotype card moved out to `<ChronotypeSection>`, the
 * prominent bottom treatment of the Sleep view; this section now owns the
 * sleep-debt headline alone. Both read the same `["sleep-rhythm"]` cache.
 *
 * States, mirroring the glucose clinical panel's treatment:
 *   - loading  → skeleton (distinct from a settled-but-empty read)
 *   - error    → a quiet inline notice, never an endless skeleton
 *   - settled  → the debt card, which carries its OWN calm "still learning" /
 *                source-cue copy for the no-nights-yet case (the route always
 *                returns a full DTO, so emptiness surfaces inside the card).
 */
export function SleepRhythmSection({ enabled }: { enabled: boolean }) {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();
  const { data, isLoading, isError } = useSleepRhythm(
    isAuthenticated && enabled,
  );

  if (!enabled) return null;

  if (isError) {
    return (
      <div
        data-slot="sleep-rhythm-error"
        role="status"
        className="bg-card border-border text-muted-foreground rounded-xl border p-4 text-sm"
      >
        {t("insights.sleep.rhythm.loadError")}
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-4" data-slot="sleep-rhythm-loading">
        <Skeleton className="h-28 w-full rounded-xl" />
      </div>
    );
  }

  return <SleepDebtCard debt={data.sleepDebt} />;
}
