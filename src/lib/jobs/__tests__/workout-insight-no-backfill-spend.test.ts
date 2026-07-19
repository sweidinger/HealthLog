import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cost claim, proved against a fixture rather than asserted about intent.
 *
 * "Re-synced and historical workouts produce zero provider calls" is the single
 * property this feature has to hold, because every ingest path in the product
 * is also a backfill path: a ten-year Apple export, a WHOOP re-sync after a
 * token refresh, a catch-up after downtime. If any of those turned into
 * generations, the feature would be a bill rather than a card.
 *
 * So this walks the REAL chain end to end with only the edges mocked:
 *
 *     emitWorkoutArrivalIfCreated / emitDataArrival   (real classifier)
 *   → boss.send                                        (counted)
 *   → runDataArrival                                   (real worker)
 *   → enqueueWorkoutInsight                            (counted)
 *
 * Nothing in the middle is stubbed, so a future edit that weakens the recency
 * test, the created-vs-updated test, or the spine's dispatch shows up here as a
 * non-zero count rather than as a passing test about a mock.
 */

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/jobs/boss-instance", () => ({ getGlobalBoss: vi.fn() }));
vi.mock("@/lib/modules/gate", () => ({ resolveModuleMap: vi.fn() }));
vi.mock("@/lib/tz/resolver", () => ({ resolveUserTimezone: vi.fn() }));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserDashboardSnapshot: vi.fn(),
}));
vi.mock("@/lib/jobs/workout-insight-generate-shared", async (orig) => {
  const actual =
    await orig<typeof import("@/lib/jobs/workout-insight-generate-shared")>();
  return {
    ...actual,
    enqueueWorkoutInsight: vi.fn(async () => ({
      enqueued: true,
    })),
  };
});

import { emitWorkoutArrivalIfCreated } from "@/lib/arrivals/workout-emit";
import { runDataArrival } from "../data-arrival";
import { enqueueWorkoutInsight } from "@/lib/jobs/workout-insight-generate-shared";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { resolveModuleMap } from "@/lib/modules/gate";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import type { DataArrival } from "@/lib/arrivals/types";

const USER = "user-1";
const TZ = "Europe/Berlin";
/** Fixed "now" so the fixture's relative dates are stable under any TZ. */
const NOW = new Date("2026-07-18T12:00:00.000Z");
const MS_PER_DAY = 86_400_000;

/** Rows the spine's `boss.send` was given, in order. */
let sent: Array<{ queue: string; payload: DataArrival }>;

/**
 * One upserted workout row. `createdAt === updatedAt` is the signal an upsert
 * CREATED the row; a re-sync bumps `updatedAt` alone.
 */
function upserted(startedAt: Date, resynced: boolean) {
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: `w-${startedAt.getTime()}${resynced ? "-r" : ""}`,
    startedAt,
    createdAt,
    updatedAt: resynced ? new Date(createdAt.getTime() + 1000) : createdAt,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  vi.mocked(getGlobalBoss).mockReturnValue({
    send: vi.fn(async (queue: string, payload: DataArrival) => {
      sent.push({ queue, payload });
      return "job-id";
    }),
  } as never);
  vi.mocked(resolveModuleMap).mockResolvedValue({
    workouts: true,
    insights: true,
  } as never);
  vi.mocked(resolveUserTimezone).mockResolvedValue(TZ);
});

/** A prisma double whose reaction claim always succeeds. */
function claimingPrisma() {
  return {
    arrivalReaction: {
      createMany: vi.fn(async () => ({ count: 1 })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  } as never;
}

describe("Activity Insight — a backfill spends nothing", () => {
  it("a three-year Apple export replay emits zero arrivals", async () => {
    // 750 sessions, one every ~36 hours going back from three days ago. The
    // export lands them all at once; every one of them is history.
    const FIXTURE_SIZE = 750;
    for (let i = 0; i < FIXTURE_SIZE; i++) {
      const startedAt = new Date(NOW.getTime() - (3 + i * 1.5) * MS_PER_DAY);
      await emitWorkoutArrivalIfCreated(
        USER,
        upserted(startedAt, false),
        "apple",
      );
    }

    expect(sent).toHaveLength(0);
    expect(enqueueWorkoutInsight).not.toHaveBeenCalled();
  });

  it("a provider re-sync of recent sessions emits zero arrivals", async () => {
    // 40 sessions from the last two days — every one of them passes the
    // recency test. They are stopped by the OTHER gate: the upsert updated an
    // existing row rather than creating one. This is the WHOOP poll case, and
    // it is the one that would otherwise re-fire on every polling interval,
    // forever.
    for (let i = 0; i < 40; i++) {
      const startedAt = new Date(
        NOW.getTime() - (i % 2) * MS_PER_DAY - 3600_000,
      );
      await emitWorkoutArrivalIfCreated(
        USER,
        upserted(startedAt, true),
        "whoop",
      );
    }

    expect(sent).toHaveLength(0);
    expect(enqueueWorkoutInsight).not.toHaveBeenCalled();
  });

  it("the two gates are independent: recent-but-updated and created-but-old both emit nothing", async () => {
    // Recent AND updated → stopped by the created-vs-updated test alone.
    await emitWorkoutArrivalIfCreated(
      USER,
      upserted(new Date(NOW.getTime() - 3600_000), true),
      "whoop",
    );
    // Created AND old → stopped by the recency test alone. A provider backfill
    // legitimately CREATES hundreds of historical rows; this is that case.
    await emitWorkoutArrivalIfCreated(
      USER,
      upserted(new Date(NOW.getTime() - 400 * MS_PER_DAY), false),
      "strava",
    );

    expect(sent).toHaveLength(0);
  });

  it("one genuinely fresh session emits exactly one arrival and one generation", async () => {
    // The positive control. Without it every count above passes vacuously —
    // a broken emit path would report zero for the happy case too.
    const fresh = upserted(new Date(NOW.getTime() - 2 * 3600_000), false);
    await emitWorkoutArrivalIfCreated(USER, fresh, "apple");

    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toMatchObject({
      userId: USER,
      kind: "workout",
      refId: fresh.id,
      count: 1,
    });

    const outcome = await runDataArrival(claimingPrisma(), sent[0].payload);
    expect(outcome.status).toBe("processed");
    expect(enqueueWorkoutInsight).toHaveBeenCalledTimes(1);
    expect(enqueueWorkoutInsight).toHaveBeenCalledWith({
      userId: USER,
      workoutId: fresh.id,
    });
  });

  it("the whole fixture together yields exactly one generation", async () => {
    // 750 historical + 40 re-synced + 1 fresh, interleaved the way a real sync
    // delivers them. The end-to-end number is the one that matters.
    const rows: Array<{ row: ReturnType<typeof upserted>; source: string }> =
      [];
    for (let i = 0; i < 750; i++) {
      rows.push({
        row: upserted(
          new Date(NOW.getTime() - (3 + i * 1.5) * MS_PER_DAY),
          false,
        ),
        source: "apple",
      });
    }
    for (let i = 0; i < 40; i++) {
      rows.push({
        row: upserted(new Date(NOW.getTime() - 3600_000 - i * 60_000), true),
        source: "whoop",
      });
    }
    rows.splice(400, 0, {
      row: upserted(new Date(NOW.getTime() - 2 * 3600_000), false),
      source: "apple",
    });

    for (const { row, source } of rows) {
      await emitWorkoutArrivalIfCreated(USER, row, source);
    }

    expect(rows).toHaveLength(791);
    expect(sent).toHaveLength(1);

    for (const job of sent) {
      await runDataArrival(claimingPrisma(), job.payload);
    }
    expect(enqueueWorkoutInsight).toHaveBeenCalledTimes(1);
  });
});
