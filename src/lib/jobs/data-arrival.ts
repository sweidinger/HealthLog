/**
 * The `data-arrival` worker — the consumer end of the arrival spine.
 *
 * It runs once per SALIENT arrival (the seam classifier has already dropped
 * every backfill), claims the day's reaction marker, and fans out to the
 * deterministic reaction surfaces.
 *
 * Two properties are load-bearing and must survive every future edit:
 *
 * 1. **No provider import, structurally.** This module — and everything
 *    reachable from it — imports no AI client and no provider resolver. The
 *    spine cannot spend a token by construction; the only AI it can cause is
 *    through explicitly budget-gated sub-queues that it merely ENQUEUES. A
 *    module-graph test (`__tests__/data-arrival-provider-isolation.test.ts`)
 *    fails if a provider module ever becomes reachable from here.
 *
 * 2. **A refusal is `skipped`, never `failed`.** Every business refusal — the
 *    module is off, the day's marker already exists, a later slice's cap is
 *    exhausted — returns a status. It does NOT throw. This is not a stylistic
 *    choice: pg-boss retries a failed job, and retrying against a ceiling that
 *    does not move until the local day rolls over is an unbounded loop. Only a
 *    genuine transient fault (pool exhaustion, a dropped connection) is allowed
 *    to escape and earn its two backed-off retries.
 *
 * The marker is claimed FIRST, before any fan-out. That ordering is deliberate:
 * the S4 morning-refresh trigger stamps its debounce marker only AFTER a
 * non-failed run, so a persistently failing downstream let every subsequent
 * sleep batch re-enqueue — an unbounded chain. Claiming up front means a
 * downstream failure costs at most the retries of ONE job, never a growing
 * queue.
 */
import type { Job } from "pg-boss";

import { invalidateUserDashboardSnapshot } from "@/lib/cache/invalidate";
import { annotate } from "@/lib/logging/context";
import { withBackgroundEvent } from "@/lib/logging/background";

import { DATA_ARRIVAL_QUEUE } from "@/lib/arrivals/emit-shared";
import { enqueueReactionLine } from "@/lib/arrivals/reaction-line-shared";
import { isArrivalKind, type DataArrival } from "@/lib/arrivals/types";
// Generator-free by construction — see that module's header. Importing the
// worker instead would make its provider clients reachable from this file and
// break the spine's structural zero-spend guard.
import { enqueueWorkoutInsight } from "@/lib/jobs/workout-insight-generate-shared";

import { getWorkerPrisma, workerLog } from "./reminder/shared";

export { DATA_ARRIVAL_QUEUE };

/**
 * What one arrival job did. `skipped` and `processed` are both SUCCESS — the
 * distinction is observability, not control flow.
 */
export type ArrivalOutcome =
  | { status: "skipped"; reason: string }
  | { status: "processed"; actions: string[]; dedup: boolean };

/**
 * Claim the day's reaction row for this (user, kind, localDate).
 *
 * `createMany` + `skipDuplicates` compiles to INSERT … ON CONFLICT DO NOTHING,
 * which is exactly the primitive wanted here and — unlike `upsert` — reports
 * whether THIS caller won the race. A returned count of 1 means we own today's
 * reaction for this kind; 0 means someone else already does.
 */
async function claimReaction(
  prisma: ReturnType<typeof getWorkerPrisma>,
  arrival: DataArrival,
): Promise<{ claimed: boolean }> {
  const occurredAt = new Date(arrival.occurredAt);

  const inserted = await prisma.arrivalReaction.createMany({
    data: [
      {
        userId: arrival.userId,
        kind: arrival.kind,
        localDate: arrival.localDate,
        occurredAt,
        refId: arrival.refId ?? null,
      },
    ],
    skipDuplicates: true,
  });

  if (inserted.count > 0) return { claimed: true };

  // Lost the claim — another arrival of this kind already landed today. Keep
  // the marker's timestamp and referent moving together so the "just in"
  // surface and reaction evidence both describe the NEWEST arrival, but never
  // move either backwards on a slightly-out-of-order sync.
  await prisma.arrivalReaction.updateMany({
    where: {
      userId: arrival.userId,
      kind: arrival.kind,
      localDate: arrival.localDate,
      occurredAt: { lt: occurredAt },
    },
    data: { occurredAt, arrivedAt: new Date(), refId: arrival.refId ?? null },
  });

  return { claimed: false };
}

/**
 * Process one arrival. Kind-dispatched, entirely deterministic, no provider
 * call anywhere on the path.
 */
export async function runDataArrival(
  prisma: ReturnType<typeof getWorkerPrisma>,
  arrival: DataArrival,
): Promise<ArrivalOutcome> {
  if (!isArrivalKind(arrival.kind)) {
    // A payload from a future version, or a hand-inserted row. Refusing is
    // correct; failing would retry it twice for nothing.
    return { status: "skipped", reason: "unknown_kind" };
  }

  const { claimed } = await claimReaction(prisma, arrival);
  const actions: string[] = [claimed ? "claimed" : "marker_refreshed"];

  switch (arrival.kind) {
    case "sleep_night":
      // Nothing extra. `morning-digest-refresh` already owns the
      // provisional → final flip for the day, enqueued by the same seam that
      // emitted this arrival; duplicating it here would double the work and
      // race its marker. The row this worker just wrote is what powers the
      // "just in" surface.
      actions.push("sleep_marker_only");
      break;

    case "workout":
      // The per-workout Activity Insight. Deliberately NOT gated on `claimed`:
      // two workouts in one day are two events and both deserve a paragraph,
      // whereas the day-scoped marker can only be claimed once. Its own
      // once-per-workout key, duration floor, hard daily cap, input hash and
      // token-ledger reservation bound the spend — none of which belong in the
      // spine, which is why only the generator-free enqueue is imported here.
      if (arrival.refId) {
        const insight = await enqueueWorkoutInsight({
          userId: arrival.userId,
          workoutId: arrival.refId,
        });
        if (!insight.enqueued) {
          throw new Error("Workout insight enqueue failed");
        }
        actions.push("workout_insight_enqueued");
      } else {
        // A workout arrival with no referent cannot address a paragraph. The
        // seams always carry one; annotating rather than guessing keeps a
        // future seam that forgets it visible.
        actions.push("workout_no_ref");
      }
      break;

    case "weight":
    case "blood_pressure":
    case "labs_panel":
      // Marker only. The Today surface reads the row directly.
      actions.push("marker_only");
      break;
  }

  if (claimed) {
    // The day's single reaction line. Gated on `claimed` precisely BECAUSE the
    // unique row is the throttle: this is the only pass that can have won the
    // claim, so there is no code path to a second generation for this kind
    // today. The enqueue helper is provider-free by construction (see its
    // docblock and the module-graph guard) — this worker still spends nothing.
    await enqueueReactionLine({
      userId: arrival.userId,
      kind: arrival.kind,
      localDate: arrival.localDate,
    });
    actions.push("line_pending");
  }

  // Best-effort and same-process only. `ServerCache` is per-process
  // in-memory, so a worker eviction does not reach the web process; the short
  // read TTLs plus the client's foreground poll are the real freshness floor.
  // Called anyway because in a single-container deployment it IS the web
  // process, and it costs nothing when it is not.
  try {
    invalidateUserDashboardSnapshot(arrival.userId);
  } catch {
    // A cache miss is never worth failing a job over.
  }

  return { status: "processed", actions, dedup: !claimed };
}

export async function handleDataArrival(
  jobs: Job<DataArrival>[],
): Promise<void> {
  await withBackgroundEvent("job.data_arrival", async (evt) => {
    for (const job of jobs) {
      const arrival = job.data;
      try {
        const outcome = await runDataArrival(getWorkerPrisma(), arrival);

        if (outcome.status === "skipped") {
          annotate({
            action: { name: `arrival.${arrival.kind}.skipped` },
            meta: { reason: outcome.reason, source: arrival.source },
          });
          evt.addMeta("arrival", `${arrival.kind}:skipped:${outcome.reason}`);
          continue;
        }

        annotate({
          action: { name: `arrival.${arrival.kind}.processed` },
          meta: {
            actions: outcome.actions.join(","),
            dedup: outcome.dedup,
            source: arrival.source,
            local_date: arrival.localDate,
          },
        });
        evt.addMeta(
          "arrival",
          `${arrival.kind}:processed:${outcome.actions.join("|")}`,
        );
      } catch (err) {
        // Reached only by a genuine transient fault — every business refusal
        // returned a status above. Rethrow so the queue's two backed-off
        // retries apply; the marker claim is idempotent, so a retry is safe.
        workerLog("error", "[data-arrival] pass failed", err);
        throw err;
      }
    }
  });
}
