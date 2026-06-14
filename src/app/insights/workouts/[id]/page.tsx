"use client";

import { use } from "react";

import { useTranslations } from "@/lib/i18n/context";
import { useWorkoutDetail } from "@/hooks/use-workouts";
import { BackLink } from "@/components/ui/back-link";
import { CoachLaunchButton } from "@/components/insights/coach-launch-button";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import {
  WorkoutDetailHeader,
  WorkoutDetailHRChart,
  WorkoutDetailRoute,
  WorkoutDetailStats,
} from "@/components/insights/workout-detail";

/**
 * v1.4.32 — `/insights/workouts/[id]`.
 *
 * Workout detail surface. Mounts the header + stats + optional GPS
 * route + heart-rate chart slot. The route data flows from
 * `GET /api/workouts/{id}` (v1.4.32) and includes the cross-source
 * canonical-id pointer so a deep-link into a non-canonical twin
 * surfaces a graceful redirect cue (handled inline on the header for
 * v1.4.32; iOS-side redirect arrives in v1.5).
 */
export default function InsightsWorkoutDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { t } = useTranslations();
  const { id } = use(params);
  const { data, isLoading, error } = useWorkoutDetail(id);

  return (
    <SubPageShell
      title={t("insights.workouts.title")}
      description={t("insights.workouts.description")}
      backLink={
        <BackLink
          href="/insights/workouts"
          label={t("insights.workouts.detail.backToList")}
          dataSlot="workout-detail-back"
        />
      }
    >
      {isLoading ? (
        <div data-slot="workout-detail-loading" className="space-y-3">
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-40 w-full rounded-lg" />
          <Skeleton className="h-60 w-full rounded-lg" />
        </div>
      ) : error || !data ? (
        <p
          data-slot="workout-detail-error"
          className="text-muted-foreground text-sm"
        >
          {t("insights.workouts.detail.notFound")}
        </p>
      ) : (
        <>
          <WorkoutDetailHeader workout={data} />
          <WorkoutDetailStats workout={data} />
          <WorkoutDetailRoute workout={data} />
          <WorkoutDetailHRChart workout={data} />
          <CoachLaunchButton />
        </>
      )}
    </SubPageShell>
  );
}
