import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StravaWorkoutRow } from "../client";

const { createManyAndReturn, update, emitInsertedWorkoutArrival } = vi.hoisted(
  () => ({
    createManyAndReturn: vi.fn(),
    update: vi.fn(),
    emitInsertedWorkoutArrival: vi.fn(async () => {}),
  }),
);

vi.mock("@/lib/db", () => ({
  prisma: { workout: { createManyAndReturn, update } },
}));
vi.mock("@/lib/arrivals/workout-emit", () => ({
  emitInsertedWorkoutArrival,
}));
vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: () => ({ addWarning: vi.fn() }),
}));

import { upsertStravaWorkouts } from "../sync";

const startedAt = new Date("2026-07-19T08:00:00.000Z");
const row: StravaWorkoutRow = {
  externalId: "strava-1",
  sportType: "running",
  startedAt,
  endedAt: new Date("2026-07-19T09:00:00.000Z"),
  durationSec: 3600,
  totalEnergyKcal: 500,
  totalDistanceM: 10_000,
  avgHeartRate: 145,
  maxHeartRate: 170,
  elevationM: 80,
  metadata: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({ id: "existing" });
});

describe("upsertStravaWorkouts — exact inserted identity", () => {
  it("emits the exact row returned by the insert statement", async () => {
    const inserted = { id: "new-workout", startedAt };
    createManyAndReturn.mockResolvedValue([inserted]);

    await expect(upsertStravaWorkouts("user-1", [row])).resolves.toBe(1);

    expect(emitInsertedWorkoutArrival).toHaveBeenCalledWith(
      "user-1",
      inserted,
      "strava",
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("updates and counts an existing workout without emitting", async () => {
    createManyAndReturn.mockResolvedValue([]);

    await expect(upsertStravaWorkouts("user-1", [row])).resolves.toBe(1);

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_source_externalId: {
            userId: "user-1",
            source: "STRAVA",
            externalId: "strava-1",
          },
        },
        data: expect.objectContaining({
          sportType: "running",
          startedAt,
          metadata: {},
        }),
      }),
    );
    expect(emitInsertedWorkoutArrival).not.toHaveBeenCalled();
  });

  it("reconciles every short-return loser and emits only returned insert rows", async () => {
    const second = { ...row, externalId: "strava-2" };
    const inserted = { id: "new-workout", startedAt };
    createManyAndReturn
      .mockResolvedValueOnce([inserted])
      .mockResolvedValueOnce([]);

    await expect(upsertStravaWorkouts("user-1", [row, second])).resolves.toBe(
      2,
    );

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_source_externalId: {
            userId: "user-1",
            source: "STRAVA",
            externalId: "strava-2",
          },
        },
      }),
    );
    expect(emitInsertedWorkoutArrival).toHaveBeenCalledTimes(1);
    expect(emitInsertedWorkoutArrival).toHaveBeenCalledWith(
      "user-1",
      inserted,
      "strava",
    );
  });

  it("keeps a successful insert when arrival dispatch fails", async () => {
    createManyAndReturn.mockResolvedValue([{ id: "new-workout", startedAt }]);
    emitInsertedWorkoutArrival.mockRejectedValueOnce(new Error("queue down"));

    await expect(upsertStravaWorkouts("user-1", [row])).resolves.toBe(1);
  });
});
