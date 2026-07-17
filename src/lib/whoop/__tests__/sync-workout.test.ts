/**
 * `upsertWhoopWorkout` — canonical sport mapping + metadata traceability.
 *
 * Regression coverage for the confirmed prod bug: a WHOOP cycling workout
 * wrote `Workout.sportType = "whoop_sport_1"` (or the raw `sport_name`)
 * instead of the canonical `"cycling"`, so it never rendered as cycling on
 * `/insights/workouts`. `upsertWhoopWorkout` must now route through
 * `mapWhoopSportType()` and keep the raw WHOOP fields in `metadata` for
 * traceability.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client", () => ({
  fetchWorkouts: vi.fn(),
  fetchWorkoutById: vi.fn(),
  KJ_TO_KCAL: 0.239006,
}));

vi.mock("../sync", async () => {
  const actual = await vi.importActual<typeof import("../sync")>("../sync");
  return {
    ...actual,
    getValidToken: vi.fn(),
    markResourceSynced: vi.fn(),
  };
});

const workoutUpsert = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    whoopConnection: { findUnique: vi.fn() },
    workout: { upsert: (...a: unknown[]) => workoutUpsert(...a) },
  },
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({ addWarning: vi.fn() }),
}));

import { upsertWhoopWorkout } from "../sync-workout";
import type { WhoopWorkout } from "../client";

function scoredWorkout(overrides: Partial<WhoopWorkout>): WhoopWorkout {
  return {
    id: "w-1",
    user_id: 1,
    created_at: "2026-06-14T07:00:00.000Z",
    updated_at: "2026-06-14T08:00:00.000Z",
    start: "2026-06-14T07:00:00.000Z",
    end: "2026-06-14T08:00:00.000Z",
    score_state: "SCORED",
    score: {
      strain: 12.3,
      average_heart_rate: 130,
      max_heart_rate: 165,
      kilojoule: 1500,
      percent_recorded: 99,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  workoutUpsert.mockResolvedValue({});
});

describe("upsertWhoopWorkout — canonical sportType", () => {
  it("writes canonical 'cycling' for sport_id 1, never whoop_sport_1", async () => {
    await upsertWhoopWorkout("user-1", scoredWorkout({ sport_id: 1 }));
    const row = workoutUpsert.mock.calls[0]![0].create;
    expect(row.sportType).toBe("cycling");
  });

  it("writes canonical 'cycling' when WHOOP sends sport_name instead of sport_id", async () => {
    await upsertWhoopWorkout(
      "user-1",
      scoredWorkout({ sport_id: undefined, sport_name: "cycling" }),
    );
    const row = workoutUpsert.mock.calls[0]![0].create;
    expect(row.sportType).toBe("cycling");
  });

  it("falls back to 'other' for an unrecognised sport, never a whoop_sport_<n> placeholder", async () => {
    await upsertWhoopWorkout(
      "user-1",
      scoredWorkout({ sport_id: 999_999, sport_name: undefined }),
    );
    const row = workoutUpsert.mock.calls[0]![0].create;
    expect(row.sportType).toBe("other");
    expect(row.sportType).not.toMatch(/^whoop_sport_/);
  });

  it("uses the same mapped sportType on the update branch (re-sync / re-score)", async () => {
    await upsertWhoopWorkout("user-1", scoredWorkout({ sport_id: 1 }));
    const update = workoutUpsert.mock.calls[0]![0].update;
    expect(update.sportType).toBe("cycling");
  });
});

describe("upsertWhoopWorkout — raw sport fields kept in metadata for traceability", () => {
  it("stamps whoopSportId and whoopSportName onto metadata", async () => {
    await upsertWhoopWorkout(
      "user-1",
      scoredWorkout({ sport_id: 1, sport_name: "cycling" }),
    );
    const row = workoutUpsert.mock.calls[0]![0].create;
    expect(row.metadata.whoopSportId).toBe(1);
    expect(row.metadata.whoopSportName).toBe("cycling");
  });

  it("omits whoopSportId / whoopSportName from metadata when WHOOP sent neither", async () => {
    await upsertWhoopWorkout(
      "user-1",
      scoredWorkout({ sport_id: undefined, sport_name: undefined }),
    );
    const row = workoutUpsert.mock.calls[0]![0].create;
    expect(row.metadata).not.toHaveProperty("whoopSportId");
    expect(row.metadata).not.toHaveProperty("whoopSportName");
  });
});
