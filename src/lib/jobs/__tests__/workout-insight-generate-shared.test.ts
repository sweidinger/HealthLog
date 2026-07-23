import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The enqueue half of the double-post defence.
 *
 * A watch that posts the same session three times during a sync retry must not
 * buy three paragraphs. Two independent things stop it: the singleton key here,
 * which collapses the burst before it becomes work, and the unique
 * `WorkoutInsight.workoutId` row plus the input hash in the worker, which hold
 * even when the key does not.
 *
 * This file pins the first. The second is pinned in
 * `workout-insight-generate.test.ts`, deliberately without reference to this
 * one — a singleton key is a best-effort collapse, and a design that needed
 * both to hold simultaneously would have neither.
 */

vi.mock("@/lib/jobs/boss-instance", () => ({ getGlobalBoss: vi.fn() }));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import {
  enqueueWorkoutInsight,
  WORKOUT_INSIGHT_GENERATE_QUEUE,
} from "../workout-insight-generate-shared";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";

const send = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  send.mockResolvedValue("job-id");
  vi.mocked(getGlobalBoss).mockReturnValue({ send } as never);
});

describe("enqueueWorkoutInsight", () => {
  it("keys the singleton by workout id, so a double-post collapses", async () => {
    await enqueueWorkoutInsight({ userId: "u1", workoutId: "w1" });
    await enqueueWorkoutInsight({ userId: "u1", workoutId: "w1" });

    expect(send).toHaveBeenCalledTimes(2);
    for (const call of send.mock.calls) {
      expect(call[0]).toBe(WORKOUT_INSIGHT_GENERATE_QUEUE);
      // Identical keys — pg-boss collapses them. Asserting the key rather than
      // a de-duplicated count is deliberate: the collapse happens in the queue,
      // and a test that mocked it away would be asserting its own mock.
      expect(call[2]).toMatchObject({ singletonKey: "workout-insight:w1" });
    }
    expect(send.mock.calls[0][2].singletonKey).toBe(
      send.mock.calls[1][2].singletonKey,
    );
  });

  it("gives two different workouts two different keys", async () => {
    // Two sessions in one day are two events and both deserve a paragraph.
    await enqueueWorkoutInsight({ userId: "u1", workoutId: "w1" });
    await enqueueWorkoutInsight({ userId: "u1", workoutId: "w2" });

    expect(send.mock.calls[0][2].singletonKey).not.toBe(
      send.mock.calls[1][2].singletonKey,
    );
  });

  it("is a clean no-op with no worker attached", async () => {
    vi.mocked(getGlobalBoss).mockReturnValue(null as never);
    await expect(
      enqueueWorkoutInsight({ userId: "u1", workoutId: "w1" }),
    ).resolves.toEqual({ enqueued: false });
  });

  it("never throws when the send itself fails", async () => {
    // The ingest that triggered this has already written its rows. A queue
    // hiccup may not surface as a failed sync.
    send.mockRejectedValue(new Error("pool exhausted"));
    await expect(
      enqueueWorkoutInsight({ userId: "u1", workoutId: "w1" }),
    ).resolves.toEqual({ enqueued: false });
  });
});
