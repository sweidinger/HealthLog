/**
 * The per-workout Activity Insight worker.
 *
 * Dispatched by the data-arrival spine when a workout genuinely LANDS. There is
 * no other trigger and there is deliberately no regenerate button: a per-workout
 * provider button is a saturation surface, and a read path that could generate
 * would turn opening the workout list on a fresh install into a bill.
 *
 * The consequence is worth stating because it looks like a bug and is not: every
 * workout that predates this feature, and every workout re-synced from a
 * provider backfill, renders NO card, forever. That is the design. The spine's
 * recency classifier drops historical samples before anything is enqueued, the
 * upsert seams only emit for rows they actually created, and nothing on the read
 * side ever writes here.
 *
 * Five gates stand in front of the provider, in ascending cost order, and each
 * is a claim on its own rather than a layer of one claim:
 *
 *   1. modules   — `workouts` AND `insights` on
 *   2. duration  — at least ten minutes of session
 *   3. daily cap — at most four paragraphs generated today
 *   4. inputHash — the evidence is unchanged since the last paragraph
 *   5. budget    — the token ledger, inside `runStatusCompletion`
 *
 * Gate 3 and gate 4 both independently stop a device double-post, which is why
 * they are both here: the singleton queue key that would normally collapse a
 * burst is best-effort, and a lost singleton race is an ordinary event.
 *
 * Every business refusal RETURNS a status. It does not throw. pg-boss retries a
 * failed job, and retrying against a daily cap that does not move until midnight
 * is an unbounded loop. Only a genuine transient fault escapes to earn its
 * backed-off retries.
 */
import type { Job } from "pg-boss";

import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { openerArchetypeHint } from "@/lib/ai/prompts/opener-archetype";
import {
  getWorkoutInsightSystemPrompt,
  getWorkoutInsightUserPrompt,
  WORKOUT_INSIGHT_PROMPT_VERSION,
} from "@/lib/ai/prompts/workout-insight";
import { prisma } from "@/lib/db";
import { pickCanonicalWorkoutRows } from "@/lib/measurements/pick-canonical-workout-rows";
import { defaultLocale, locales, type Locale } from "@/lib/i18n/config";
import { finalizeStatusSummary } from "@/lib/insights/status-shared";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import { annotate } from "@/lib/logging/context";
import { withBackgroundEvent } from "@/lib/logging/background";
import { resolveModuleMap } from "@/lib/modules/gate";
import { userDayKey } from "@/lib/tz/format";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { buildWorkoutHrSeries } from "@/lib/workouts/hr-series";
import {
  buildWorkoutInsightEvidence,
  OWN_HISTORY_LOOKBACK_DAYS,
  OWN_HISTORY_MAX_ROWS,
} from "@/lib/workouts/insight-evidence";
import {
  MAX_INSIGHTS_PER_DAY,
  meetsDurationFloor,
  workoutInsightInputHash,
} from "@/lib/workouts/insight-gates";
import { getAgeFromDateOfBirth } from "@/lib/analytics/pulse-targets";
import {
  computeZones,
  hrMaxFromAge,
  parseWhoopZoneDurations,
} from "@/lib/workouts/zones";

import {
  WORKOUT_INSIGHT_GENERATE_CONCURRENCY,
  WORKOUT_INSIGHT_GENERATE_QUEUE,
  type WorkoutInsightGeneratePayload,
} from "./workout-insight-generate-shared";

export { WORKOUT_INSIGHT_GENERATE_CONCURRENCY, WORKOUT_INSIGHT_GENERATE_QUEUE };
export type { WorkoutInsightGeneratePayload };

const MS_PER_DAY = 86_400_000;

/**
 * What one run did. `skipped` is a SUCCESS — the distinction is observability.
 */
export type WorkoutInsightOutcome =
  | { status: "skipped"; reason: string }
  | { status: "generated"; providerType: string; length: number };

/**
 * Generate one workout's paragraph. Owner-scoped throughout: `userId` comes
 * from the queue payload the spine wrote from an authenticated ingest, and it
 * is in the `where` of every read and every write below. There is no path here
 * that resolves a workout by id alone.
 */
export async function runWorkoutInsightGenerate(
  payload: WorkoutInsightGeneratePayload,
  now: Date = new Date(),
): Promise<WorkoutInsightOutcome> {
  const { userId, workoutId } = payload;
  if (!userId || !workoutId)
    return { status: "skipped", reason: "bad_payload" };

  // ── Gate 1: modules ──────────────────────────────────────────────────────
  // Both, not either. `workouts` is the domain the surface lives in and
  // `insights` is the AI surface family it belongs to; a user who turned either
  // off has said no to this card.
  const modules = await resolveModuleMap(userId);
  if (modules.workouts === false || modules.insights === false) {
    return { status: "skipped", reason: "module_off" };
  }

  const row = await prisma.workout.findFirst({
    where: { id: workoutId, userId },
    select: {
      id: true,
      sportType: true,
      startedAt: true,
      endedAt: true,
      durationSec: true,
      totalDistanceM: true,
      totalEnergyKcal: true,
      avgHeartRate: true,
      maxHeartRate: true,
      minHeartRate: true,
      elevationM: true,
      metadata: true,
      route: { select: { geometry: true } },
      samples: { select: { samples: true } },
    },
  });
  // Gone between the emit and the run (a hard delete), or never ours.
  if (!row) return { status: "skipped", reason: "not_found" };

  // ── Gate 2: duration floor ───────────────────────────────────────────────
  // A four-minute walk has no zone distribution, no front/back-half story and
  // nothing to compare. Silence is the honest output.
  if (!meetsDurationFloor(row.durationSec)) {
    annotate({
      action: { name: "workouts.insight.skipped" },
      meta: { workoutId, reason: "too_short", durationSec: row.durationSec },
    });
    return { status: "skipped", reason: "too_short" };
  }

  const tz = await resolveUserTimezone(userId);

  // ── Gate 3: hard daily cap ───────────────────────────────────────────────
  // A COUNT, not a rate limit. It holds even if the queue key, the unique row
  // and the hash all fail at once — which is exactly what a hard cap is for.
  // The window is the USER's local day, so "four a day" means what a user
  // would mean by it, not what UTC would.
  const dayStart = startOfUserDay(now, tz);
  const generatedToday = await prisma.workoutInsight.count({
    where: { userId, generatedAt: { gte: dayStart } },
  });
  if (generatedToday >= MAX_INSIGHTS_PER_DAY) {
    annotate({
      action: { name: "workouts.insight.skipped" },
      meta: { workoutId, reason: "daily_cap", generatedToday },
    });
    return { status: "skipped", reason: "daily_cap" };
  }

  // ── Evidence: deterministic, numbers-only, no free text ──────────────────
  const profile = await prisma.user.findUnique({
    where: { id: userId },
    select: { dateOfBirth: true, locale: true, sourcePriorityJson: true },
  });

  // The SAME builder the detail route serves `hrSeries` from — not the
  // day-scoped intraday read, which would answer a question about the day
  // rather than about the session.
  const hrSeries = await buildWorkoutHrSeries({
    userId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationSec: row.durationSec,
    storedSamples: row.samples?.samples ?? null,
    now,
  });

  const zones = computeZones({
    hrMax: hrMaxFromAge(getAgeFromDateOfBirth(profile?.dateOfBirth ?? null)),
    series: hrSeries?.points ?? [],
    bucketSec: hrSeries?.bucketSec ?? 0,
    whoopZoneDurations: parseWhoopZoneDurations(row.metadata),
  });

  // Own-history rows for the comparison. `sportType` is the RAW column here on
  // purpose — this is a database equality filter, not prompt input, so it must
  // match what is stored; the value is narrowed to the closed enum later, at
  // the projection boundary.
  const historyRows = await prisma.workout.findMany({
    where: {
      userId,
      sportType: row.sportType,
      id: { not: row.id },
      startedAt: {
        gte: new Date(
          row.startedAt.getTime() - OWN_HISTORY_LOOKBACK_DAYS * MS_PER_DAY,
        ),
        lt: row.startedAt,
      },
    },
    orderBy: { startedAt: "desc" },
    take: OWN_HISTORY_MAX_ROWS,
    select: {
      id: true,
      source: true,
      startedAt: true,
      sportType: true,
      durationSec: true,
      avgHeartRate: true,
      totalDistanceM: true,
      totalEnergyKcal: true,
    },
  });

  // Collapse cross-source twins BEFORE the medians, the same way the detail
  // page's sport-context read does. A session recorded by two paired devices
  // (an Apple Watch and a Withings ScanWatch) is one session; counting it twice
  // inflates the sample size and biases every median the paragraph quotes.
  const history = pickCanonicalWorkoutRows(
    historyRows,
    profile?.sourcePriorityJson ?? null,
  );

  const evidence = buildWorkoutInsightEvidence({
    row,
    tz,
    hrSeries,
    zones,
    // `metadata` is NOT passed. The projection reads closed numeric fields
    // only; device bundle ids and event markers never reach a prompt.
    routeGeometry: row.route?.geometry ?? null,
    history,
  });

  // ── Gate 4: input hash ───────────────────────────────────────────────────
  // The cheapest real gate and the one that makes a re-sync free. It runs
  // BEFORE any provider is resolved, so an unchanged session costs one indexed
  // read and nothing else.
  const inputHash = workoutInsightInputHash(
    evidence,
    WORKOUT_INSIGHT_PROMPT_VERSION,
  );
  const existing = await prisma.workoutInsight.findFirst({
    where: { workoutId, userId },
    select: { id: true, inputHash: true },
  });
  if (existing && existing.inputHash === inputHash) {
    annotate({
      action: { name: "workouts.insight.skipped" },
      meta: { workoutId, reason: "unchanged" },
    });
    return { status: "skipped", reason: "unchanged" };
  }

  // ── Generation ───────────────────────────────────────────────────────────
  // The reader's stored preference is the source: this job has no request. The
  // paragraph is written once, in that language, and a later language switch
  // does NOT regenerate — a read path may never trigger a provider call.
  const locale: Locale = (locales as readonly string[]).includes(
    profile?.locale ?? "",
  )
    ? (profile?.locale as Locale)
    : defaultLocale;

  // ── Gate 5: the token ledger ─────────────────────────────────────────────
  // `runStatusCompletion` is the chokepoint that owns reserve → provider →
  // reconcile for the whole status family, including the refund on a timeout
  // or an error. Reserving separately here would double-charge the day.
  const outcome = await runStatusCompletion({
    userId,
    cacheAction: "insights.workout-insight",
    consentSurface: "insights",
    systemPrompt: getWorkoutInsightSystemPrompt(locale),
    userPrompt: getWorkoutInsightUserPrompt(
      JSON.stringify(evidence),
      userDayKey(now, tz),
      locale,
      openerArchetypeHint(`${userId}:workout:${workoutId}`, locale),
    ),
    temperature: AI_BUDGETS.workoutInsight.temperature,
    maxTokens: AI_BUDGETS.workoutInsight.maxTokens,
  });

  if (outcome.kind !== "ok") {
    // No provider, no consent, budget spent, timeout, provider error — all the
    // same to this surface: no row, no card, no retry loop. The stats the page
    // already renders are the floor and they never needed AI.
    annotate({
      action: { name: "workouts.insight.skipped" },
      meta: { workoutId, reason: outcome.kind },
    });
    return { status: "skipped", reason: outcome.kind };
  }

  // The outbound safety screen every generated assessment passes through.
  // WITHHOLD: a paragraph that tripped it is never shown as if it were fine.
  const screened = finalizeStatusSummary(outcome.content, locale);
  if (!screened.ok || !screened.text) {
    annotate({
      action: { name: "workouts.insight.outbound_blocked" },
      meta: { workoutId, reason: screened.ok ? "empty" : screened.reason },
    });
    return { status: "skipped", reason: "screened" };
  }

  const data = {
    paragraphEncrypted: encryptToBytes(screened.text),
    inputHash,
    promptVersion: WORKOUT_INSIGHT_PROMPT_VERSION,
    providerType: outcome.providerType,
    locale,
    generatedAt: now,
  };

  // Upsert on the unique workout id. The constraint is the durable half of the
  // double-post defence: if two workers did somehow both reach here, one write
  // wins and the other updates it in place rather than creating a twin.
  await prisma.workoutInsight.upsert({
    where: { workoutId },
    create: { userId, workoutId, ...data },
    update: data,
  });

  annotate({
    action: { name: "workouts.insight.generated" },
    meta: {
      workoutId,
      providerType: outcome.providerType,
      sportType: evidence.sportType,
      length: screened.text.length,
    },
  });
  return {
    status: "generated",
    providerType: outcome.providerType,
    length: screened.text.length,
  };
}

/** Midnight in the user's profile timezone, as an absolute instant. */
function startOfUserDay(now: Date, tz: string): Date {
  const key = userDayKey(now, tz);
  // Walk back from `now` to the first instant whose day key differs. Bounded to
  // 48 hourly steps, which covers every real offset including the half-hour and
  // 45-minute zones plus a DST shift.
  let cursor = now.getTime();
  for (let i = 0; i < 48; i++) {
    const next = cursor - 3_600_000;
    if (userDayKey(new Date(next), tz) !== key) {
      // Refine to the minute so a cap window is not up to an hour wide.
      for (let m = 0; m < 60; m++) {
        const candidate = cursor - m * 60_000;
        if (userDayKey(new Date(candidate), tz) !== key) {
          return new Date(candidate + 60_000);
        }
      }
      return new Date(cursor);
    }
    cursor = next;
  }
  return new Date(now.getTime() - MS_PER_DAY);
}

export async function handleWorkoutInsightGenerate(
  jobs: Job<WorkoutInsightGeneratePayload>[],
): Promise<void> {
  await withBackgroundEvent("job.workout_insight_generate", async (evt) => {
    for (const job of jobs) {
      const outcome = await runWorkoutInsightGenerate(job.data);
      evt.addMeta(
        "workout_insight",
        outcome.status === "skipped"
          ? `skipped:${outcome.reason}`
          : `generated:${outcome.providerType}`,
      );
    }
  });
}
