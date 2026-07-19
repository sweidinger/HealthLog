/**
 * The `data-arrival` worker's contract.
 *
 * Two properties carry real risk and are pinned here:
 *
 *   - The marker is claimed BEFORE any fan-out. The S4 morning-refresh trigger
 *     stamps its debounce marker only after a non-failed run, so a persistently
 *     failing downstream let every subsequent sleep batch re-enqueue — an
 *     unbounded chain. Claiming up front bounds a downstream failure to the
 *     retries of one job.
 *   - A refusal returns `skipped`; it does not throw. pg-boss retries a failed
 *     job, and retrying against a ceiling that will not move until the local
 *     day rolls over is a loop.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: async (
    _name: string,
    fn: (evt: { addMeta: () => void }) => Promise<void>,
  ) => fn({ addMeta: () => {} }),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserDashboardSnapshot: vi.fn(),
}));
vi.mock("@/lib/jobs/reminder/shared", () => ({
  getWorkerPrisma: () => fakePrisma,
  workerLog: vi.fn(),
}));

const createMany = vi.fn(async () => ({ count: 1 }));
const updateMany = vi.fn(async () => ({ count: 1 }));
const fakePrisma = { arrivalReaction: { createMany, updateMany } };

const { runDataArrival } = await import("../data-arrival");

type Runnable = Parameters<typeof runDataArrival>[1];

function arrival(overrides: Partial<Runnable> = {}): Runnable {
  return {
    userId: "user-1",
    kind: "weight",
    salience: "salient",
    localDate: "2026-07-14",
    occurredAt: "2026-07-14T06:15:00.000Z",
    count: 1,
    source: "withings",
    ...overrides,
  } as Runnable;
}

beforeEach(() => {
  createMany.mockClear().mockResolvedValue({ count: 1 });
  updateMany.mockClear().mockResolvedValue({ count: 1 });
});

describe("data-arrival worker", () => {
  it("claims the day's marker before any fan-out", async () => {
    const result = await runDataArrival(
      fakePrisma as never,
      arrival({ kind: "workout", refId: "w-1" }),
    );
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0]).toMatchObject({ skipDuplicates: true });
    expect(result).toMatchObject({ status: "processed", dedup: false });
  });

  it("a lost claim de-duplicates instead of writing a second line", async () => {
    createMany.mockResolvedValue({ count: 0 });
    const result = await runDataArrival(fakePrisma as never, arrival());
    expect(result).toMatchObject({ status: "processed", dedup: true });
    if (result.status !== "processed") throw new Error("unreachable");
    expect(result.actions).not.toContain("line_pending");
  });

  it("only a fresh claim schedules the day's reaction line", async () => {
    const first = await runDataArrival(fakePrisma as never, arrival());
    if (first.status !== "processed") throw new Error("unreachable");
    expect(first.actions).toContain("line_pending");
  });

  it("a second workout the same day still fans out, despite the day marker", async () => {
    // The day-scoped marker can only be claimed once, but two sessions are two
    // events. Gating the workout fan-out on the claim would silently drop the
    // second one.
    createMany.mockResolvedValue({ count: 0 });
    const result = await runDataArrival(
      fakePrisma as never,
      arrival({ kind: "workout", refId: "w-2" }),
    );
    if (result.status !== "processed") throw new Error("unreachable");
    expect(result.actions).toContain("workout_pending_insight");
  });

  it("moves the marker forward on a later arrival, never backwards", async () => {
    createMany.mockResolvedValue({ count: 0 });
    await runDataArrival(fakePrisma as never, arrival());
    const where = updateMany.mock.calls[0][0] as {
      where: { occurredAt?: { lt?: Date } };
    };
    expect(where.where.occurredAt?.lt).toBeInstanceOf(Date);
  });

  it("refuses an unknown kind as SKIPPED, not FAILED", async () => {
    const result = await runDataArrival(
      fakePrisma as never,
      arrival({ kind: "not_a_kind" as never }),
    );
    // A throw here would earn two pointless retries against a payload that can
    // never succeed.
    expect(result).toEqual({ status: "skipped", reason: "unknown_kind" });
    expect(createMany).not.toHaveBeenCalled();
  });

  it("a genuine transient fault DOES propagate, so the retry policy applies", async () => {
    createMany.mockRejectedValue(new Error("connection terminated"));
    await expect(
      runDataArrival(fakePrisma as never, arrival()),
    ).rejects.toThrow("connection terminated");
  });
});
