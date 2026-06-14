/**
 * v1.16.13 (iOS #17) — WHOOP workout ingest used only a 1 h overlap window
 * while recovery/sleep use the wide re-score overlap. A workout whose phone
 * sync to the WHOOP cloud lands more than 1 h after the workout's own time
 * window then falls permanently before the incremental `start` and is never
 * ingested. This pins the workout sync onto the SAME overlap recovery/sleep
 * use, so a late-synced workout is still re-fetched (the upsert is idempotent).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWorkouts = vi.fn();

vi.mock("../client", () => ({
  fetchWorkouts: (...a: unknown[]) => fetchWorkouts(...a),
  KJ_TO_KCAL: 0.239006,
}));

const getValidToken = vi.fn();
const markSynced = vi.fn();
vi.mock("../sync", async () => {
  const actual = await vi.importActual<typeof import("../sync")>("../sync");
  return {
    ...actual,
    getValidToken: (...a: unknown[]) => getValidToken(...a),
    markSynced: (...a: unknown[]) => markSynced(...a),
  };
});

const whoopConnectionFindUnique = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    whoopConnection: {
      findUnique: (...a: unknown[]) => whoopConnectionFindUnique(...a),
    },
    workout: { upsert: vi.fn() },
  },
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({ addWarning: vi.fn() }),
}));

import { syncUserWorkout } from "../sync-workout";
import { WHOOP_RECOVERY_SLEEP_OVERLAP_MS } from "../sync";

const LAST_SYNCED = new Date("2026-06-10T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  getValidToken.mockResolvedValue({
    accessToken: "tok",
    connection: { id: "c1", whoopUserId: "w1" },
  });
  whoopConnectionFindUnique.mockResolvedValue({ lastSyncedAt: LAST_SYNCED });
  markSynced.mockResolvedValue(undefined);
  fetchWorkouts.mockResolvedValue([]);
});

describe("syncUserWorkout — late-synced workout overlap window", () => {
  it("fetches from lastSyncedAt minus the recovery/sleep overlap, not 1 h", async () => {
    await syncUserWorkout("user-1");
    expect(fetchWorkouts).toHaveBeenCalledTimes(1);
    const arg = fetchWorkouts.mock.calls[0]![1] as { start?: Date };
    expect(arg.start?.getTime()).toBe(
      LAST_SYNCED.getTime() - WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
    );
    // A workout that landed in the WHOOP cloud 6 h after its window is still
    // inside the fetch range; under the old 1 h overlap it would be missed.
    const sixHoursBefore = LAST_SYNCED.getTime() - 6 * 60 * 60 * 1000;
    expect(arg.start!.getTime()).toBeLessThanOrEqual(sixHoursBefore);
  });

  it("fullSync passes no start (deep backfill anchor handles history)", async () => {
    await syncUserWorkout("user-1", { fullSync: true });
    const arg = fetchWorkouts.mock.calls[0]![1] as { start?: Date };
    expect(arg.start).toBeUndefined();
  });
});
