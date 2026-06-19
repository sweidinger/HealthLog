"use client";

import { Clock } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "@/lib/i18n/context";
import { SectionHeading } from "@/components/insights/section-heading";
import { useSleepRhythm } from "./use-sleep-rhythm";
import { ChronotypeCard } from "./chronotype-card";

/**
 * v1.18.7 W-D — chronotype as the prominent bottom block of the Sleep view.
 *
 * Split out of `<SleepRhythmSection>` (which now owns only the sleep-debt
 * headline) so the chronotype gets a full-width treatment at the end of the
 * page: a large band label, the natural sleep-midpoint clock beneath it, and an
 * expandable disclosure for social jetlag + MSFsc. Reads the SAME
 * server-authoritative DTO via `useSleepRhythm`, so it shares the
 * `["sleep-rhythm"]` cache the debt section already warmed — no extra
 * round-trip. Gated on `enabled` so a source-less account never fetches.
 *
 * States mirror the debt section: loading → skeleton, error → quiet inline
 * notice, settled → the card (which carries its own calm "still learning"
 * copy for the no-nights-yet case, since the route always returns a full DTO).
 */
export function ChronotypeSection({ enabled }: { enabled: boolean }) {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();
  const { data, isLoading, isError } = useSleepRhythm(
    isAuthenticated && enabled,
  );

  if (!enabled) return null;

  return (
    <section data-slot="chronotype-section" className="space-y-3">
      <SectionHeading
        icon={Clock}
        title={t("insights.sleep.chronotype.title")}
      />
      {isError ? (
        <div
          data-slot="chronotype-error"
          role="status"
          className="bg-card border-border text-muted-foreground rounded-xl border p-4 text-sm"
        >
          {t("insights.sleep.rhythm.loadError")}
        </div>
      ) : isLoading || !data ? (
        <Skeleton
          data-slot="chronotype-loading"
          className="h-32 w-full rounded-xl"
        />
      ) : (
        <ChronotypeCard chronotype={data.chronotype} />
      )}
    </section>
  );
}
