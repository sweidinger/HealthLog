/**
 * The acceptance gate for the arrival spine.
 *
 * The spine sits in front of every ingest path in the product, so its one
 * existential failure mode is a backfill storm: a mass import turning into
 * thousands of queued jobs and, downstream, provider calls. This file proves
 * the opposite against REALISTIC replayed volumes rather than a hand-picked
 * two-row case — a hand-picked case would pass even if the classifier only
 * happened to be right at the boundary it was written against.
 *
 * Two heavy fixtures:
 *
 *   - a multi-year Apple Health export (daily weights, blood-pressure pairs,
 *     sleep nights and workouts across ten years), replayed as the export
 *     importer replays it;
 *   - a 30-day provider re-sync (the shape a WHOOP / Fitbit / Google catch-up
 *     takes after a token refresh or downtime).
 *
 * Both must emit ZERO salient events. Then the same seams, given genuinely
 * fresh data, must emit EXACTLY ONE each.
 *
 * The assertions are on `boss.send` — the actual queue write — not on the
 * classifier's return value. Testing the classifier alone would prove the
 * predicate correct while saying nothing about whether the seam consults it.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// Typed explicitly (rather than via named implementation params) so
// `.mock.calls[N][idx]` below keeps its three-argument shape without any
// parameter sitting unused in the implementation itself.
const sendMock: Mock<
  (queue: string, payload: unknown, opts: unknown) => Promise<string>
> = vi.fn(async () => "job-id");
const annotateMock = vi.fn();
let moduleMap: Record<string, boolean> = {};
let timezone = "Europe/Berlin";

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({ send: sendMock }),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: (...args: unknown[]) => annotateMock(...args),
}));

vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: async () => moduleMap,
}));

vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: async () => timezone,
}));

const { emitDataArrival } = await import("../emit-shared");

const USER = "user-fixture";

/** Wall clock the fixtures are replayed against: a Tuesday afternoon. */
const NOW = new Date("2026-07-14T14:30:00.000Z");

const DAY_MS = 86_400_000;

beforeEach(() => {
  sendMock.mockClear();
  annotateMock.mockClear();
  moduleMap = { sleep: true, workouts: true, labs: true, insights: true };
  timezone = "Europe/Berlin";
});

/** Every action name the seam annotated, in order. */
function annotatedActions(): string[] {
  return annotateMock.mock.calls
    .map((call) => {
      const arg = call[0] as { action?: { name?: string } } | undefined;
      return arg?.action?.name;
    })
    .filter((n): n is string => typeof n === "string");
}

function skipReasons(): string[] {
  return annotateMock.mock.calls
    .map((call) => {
      const arg = call[0] as { meta?: { reason?: string } } | undefined;
      return arg?.meta?.reason;
    })
    .filter((r): r is string => typeof r === "string");
}

// ─────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────

interface ReplayedWrite {
  kind: "sleep_night" | "workout" | "weight" | "blood_pressure" | "labs_panel";
  newestSampleAt: Date;
  insertedCount: number;
  refId?: string;
}

/**
 * A ten-year Apple Health export, in the shape the importer replays it: a
 * weight most mornings, a blood-pressure pair most evenings, a sleep night
 * every night, and a workout roughly every other day. Every row is genuinely
 * INSERTED (a first import creates everything), which is exactly the case that
 * would storm if the recency test were missing — `insertedCount` alone cannot
 * save us here.
 */
function appleExportFixture(): ReplayedWrite[] {
  const writes: ReplayedWrite[] = [];
  const years = 10;
  for (let dayOffset = years * 365; dayOffset >= 2; dayOffset--) {
    const day = new Date(NOW.getTime() - dayOffset * DAY_MS);
    const at = (hour: number) =>
      new Date(
        Date.UTC(
          day.getUTCFullYear(),
          day.getUTCMonth(),
          day.getUTCDate(),
          hour,
          0,
          0,
        ),
      );

    writes.push({ kind: "weight", newestSampleAt: at(7), insertedCount: 1 });
    writes.push({
      kind: "blood_pressure",
      newestSampleAt: at(20),
      insertedCount: 2,
    });
    writes.push({
      kind: "sleep_night",
      newestSampleAt: at(6),
      insertedCount: 4,
    });
    if (dayOffset % 2 === 0) {
      writes.push({
        kind: "workout",
        newestSampleAt: at(18),
        insertedCount: 1,
        refId: `workout-${dayOffset}`,
      });
    }
  }
  return writes;
}

/**
 * A 30-day provider re-sync. Distinct from the export in two ways that matter:
 * it is recent enough that a naive "is it in the last month" test would let it
 * through, and it re-posts nights and workouts the record may already hold.
 */
function providerResyncFixture(): ReplayedWrite[] {
  const writes: ReplayedWrite[] = [];
  for (let dayOffset = 30; dayOffset >= 2; dayOffset--) {
    const day = new Date(NOW.getTime() - dayOffset * DAY_MS);
    const at = (hour: number) =>
      new Date(
        Date.UTC(
          day.getUTCFullYear(),
          day.getUTCMonth(),
          day.getUTCDate(),
          hour,
          0,
          0,
        ),
      );
    writes.push({
      kind: "sleep_night",
      newestSampleAt: at(6),
      insertedCount: 5,
    });
    writes.push({
      kind: "workout",
      newestSampleAt: at(17),
      insertedCount: 1,
      refId: `whoop-${dayOffset}`,
    });
  }
  return writes;
}

async function replay(writes: ReplayedWrite[], source: string): Promise<void> {
  for (const w of writes) {
    await emitDataArrival({
      userId: USER,
      kind: w.kind,
      newestSampleAt: w.newestSampleAt,
      insertedCount: w.insertedCount,
      refId: w.refId,
      source,
      now: NOW,
    });
  }
}

// ─────────────────────────────────────────────────────────────

describe("arrival spine — heavy backfill fixtures emit nothing", () => {
  it("a ten-year Apple Health export produces ZERO salient events", async () => {
    const writes = appleExportFixture();
    // The fixture must actually be heavy, or the assertion below is vacuous.
    expect(writes.length).toBeGreaterThan(10_000);

    await replay(writes, "apple_export");

    expect(sendMock).not.toHaveBeenCalled();
    expect(annotatedActions().every((n) => n.endsWith(".skipped"))).toBe(true);
    expect(new Set(skipReasons())).toEqual(new Set(["backfill"]));
  });

  it("a 30-day provider re-sync produces ZERO salient events", async () => {
    const writes = providerResyncFixture();
    expect(writes.length).toBeGreaterThan(50);

    await replay(writes, "whoop");

    expect(sendMock).not.toHaveBeenCalled();
    expect(new Set(skipReasons())).toEqual(new Set(["backfill"]));
  });

  it("a re-sync that INSERTS nothing produces zero events, whatever its dates", async () => {
    // The `stats:` overwrite path: rows are touched, values change, nothing is
    // new. Dated TODAY, so recency cannot be what saves it — only the
    // inserted-count test can.
    for (let i = 0; i < 500; i++) {
      await emitDataArrival({
        userId: USER,
        kind: "weight",
        newestSampleAt: new Date(NOW.getTime() - 60_000),
        insertedCount: 0,
        source: "batch",
        now: NOW,
      });
    }
    expect(sendMock).not.toHaveBeenCalled();
    expect(new Set(skipReasons())).toEqual(new Set(["noop"]));
  });

  it("a far-future sample is refused, not enqueued", async () => {
    await emitDataArrival({
      userId: USER,
      kind: "weight",
      newestSampleAt: new Date(NOW.getTime() + 3 * DAY_MS),
      insertedCount: 1,
      source: "manual",
      now: NOW,
    });
    expect(sendMock).not.toHaveBeenCalled();
    expect(skipReasons()).toContain("backfill");
  });

  it("a future sample still inside TODAY is refused by the skew guard alone", async () => {
    // Isolates the future-dated guard from the recency guard. A device clock
    // running a few hours fast produces a sample whose LOCAL DAY is today — so
    // the recency test happily passes it — but which has not happened yet.
    // Without a separate skew guard this would enqueue, and the day's reaction
    // would be claimed by a reading the user has not taken.
    await emitDataArrival({
      userId: USER,
      kind: "weight",
      newestSampleAt: new Date(NOW.getTime() + 5 * 60 * 60 * 1000),
      insertedCount: 1,
      source: "manual",
      now: NOW,
    });
    expect(sendMock).not.toHaveBeenCalled();
    expect(skipReasons()).toContain("backfill");
  });
});

describe("arrival spine — calendar-day recency across DST", () => {
  it("keeps the previous local day salient after the spring-forward day", async () => {
    timezone = "Europe/Berlin";
    await emitDataArrival({
      userId: USER,
      kind: "workout",
      // Sunday after the clock jumped from 02:00 to 03:00.
      newestSampleAt: new Date("2026-03-29T12:00:00.000Z"),
      insertedCount: 1,
      refId: "dst-spring-workout",
      source: "test",
      // Monday 00:30 CEST. Subtracting a fixed 24 h lands on Saturday
      // locally; calendar arithmetic must identify Sunday as yesterday.
      now: new Date("2026-03-29T22:30:00.000Z"),
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

describe("arrival spine — genuinely fresh data emits exactly one event", () => {
  it("a fresh sleep night emits exactly one", async () => {
    await emitDataArrival({
      userId: USER,
      kind: "sleep_night",
      // Last night, ending this morning.
      newestSampleAt: new Date("2026-07-14T05:40:00.000Z"),
      insertedCount: 6,
      source: "whoop",
      now: NOW,
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(annotatedActions()).toEqual(["arrival.sleep_night.emitted"]);
  });

  it("a fresh workout emits exactly one", async () => {
    await emitDataArrival({
      userId: USER,
      kind: "workout",
      newestSampleAt: new Date("2026-07-14T11:00:00.000Z"),
      insertedCount: 1,
      refId: "workout-fresh",
      source: "strava",
      now: NOW,
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(annotatedActions()).toEqual(["arrival.workout.emitted"]);
  });

  it("the first weight of the day emits exactly one", async () => {
    await emitDataArrival({
      userId: USER,
      kind: "weight",
      newestSampleAt: new Date("2026-07-14T06:15:00.000Z"),
      insertedCount: 1,
      source: "withings",
      now: NOW,
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(annotatedActions()).toEqual(["arrival.weight.emitted"]);
  });

  it("one fresh row buried in a heavy backfill still emits exactly one", async () => {
    // The case that matters most in production: a first-time import of an
    // export taken today. Everything historical must stay silent, and the one
    // genuinely current reading must still land.
    await replay(appleExportFixture(), "apple_export");
    expect(sendMock).not.toHaveBeenCalled();

    await emitDataArrival({
      userId: USER,
      kind: "workout",
      newestSampleAt: new Date("2026-07-14T09:00:00.000Z"),
      insertedCount: 1,
      refId: "workout-today",
      source: "apple_export",
      now: NOW,
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

describe("arrival spine — singleton keys", () => {
  it("day-scoped kinds carry the local date and NO time-slot window", async () => {
    await emitDataArrival({
      userId: USER,
      kind: "weight",
      newestSampleAt: new Date("2026-07-14T06:15:00.000Z"),
      insertedCount: 1,
      source: "withings",
      now: NOW,
    });
    const opts = sendMock.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.singletonKey).toBe(`arrival:${USER}:weight:2026-07-14`);
    // A wall-clock window cannot express a local date; asserting its ABSENCE
    // is what stops someone reintroducing one.
    expect(opts.singletonSeconds).toBeUndefined();
  });

  it("workout is keyed per workout, with the device double-post window", async () => {
    await emitDataArrival({
      userId: USER,
      kind: "workout",
      newestSampleAt: new Date("2026-07-14T11:00:00.000Z"),
      insertedCount: 1,
      refId: "workout-abc",
      source: "strava",
      now: NOW,
    });
    const opts = sendMock.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.singletonKey).toBe(`arrival:${USER}:workout:workout-abc`);
    expect(opts.singletonSeconds).toBe(300);
  });

  it("two workouts on one day do NOT collapse into one event", async () => {
    for (const id of ["workout-morning", "workout-evening"]) {
      await emitDataArrival({
        userId: USER,
        kind: "workout",
        newestSampleAt: new Date("2026-07-14T11:00:00.000Z"),
        insertedCount: 1,
        refId: id,
        source: "strava",
        now: NOW,
      });
    }
    const keys = sendMock.mock.calls.map(
      (c) => (c[2] as Record<string, unknown>).singletonKey,
    );
    expect(new Set(keys).size).toBe(2);
  });

  it("the retry policy is the cheap-worker one, not the LLM one", async () => {
    await emitDataArrival({
      userId: USER,
      kind: "weight",
      newestSampleAt: new Date("2026-07-14T06:15:00.000Z"),
      insertedCount: 1,
      source: "withings",
      now: NOW,
    });
    const opts = sendMock.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.retryLimit).toBe(2);
    expect(opts.retryBackoff).toBe(true);
  });
});

describe("arrival spine — module gating and fault isolation", () => {
  it("a disabled module emits nothing", async () => {
    moduleMap = { ...moduleMap, workouts: false };
    await emitDataArrival({
      userId: USER,
      kind: "workout",
      newestSampleAt: new Date("2026-07-14T11:00:00.000Z"),
      insertedCount: 1,
      refId: "workout-x",
      source: "strava",
      now: NOW,
    });
    expect(sendMock).not.toHaveBeenCalled();
    expect(skipReasons()).toContain("module_off");
  });

  it("an enqueue failure never propagates to the caller", async () => {
    sendMock.mockRejectedValueOnce(new Error("queue is down"));
    await expect(
      emitDataArrival({
        userId: USER,
        kind: "weight",
        newestSampleAt: new Date("2026-07-14T06:15:00.000Z"),
        insertedCount: 1,
        source: "withings",
        now: NOW,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("arrival spine — timezone honesty", () => {
  it("judges recency in the user's zone, not UTC", async () => {
    // 2026-07-14T22:30Z is still the 14th in UTC but already the 15th in
    // Auckland. A sample from 2026-07-13T20:00Z is two local days back there
    // and must be refused, while UTC arithmetic would call it "yesterday".
    timezone = "Pacific/Auckland";
    await emitDataArrival({
      userId: USER,
      kind: "weight",
      newestSampleAt: new Date("2026-07-13T00:00:00.000Z"),
      insertedCount: 1,
      source: "withings",
      now: new Date("2026-07-14T22:30:00.000Z"),
    });
    expect(sendMock).not.toHaveBeenCalled();
    expect(skipReasons()).toContain("backfill");
  });

  it("files the arrival under the user's local day, not the UTC day", async () => {
    // 23:30 in Berlin on the 14th is 21:30Z — same UTC day. Chosen the other
    // way round: 00:30 Berlin on the 15th is 22:30Z on the 14th, so the local
    // date must read 2026-07-15 while UTC still reads the 14th.
    timezone = "Europe/Berlin";
    const now = new Date("2026-07-14T22:30:00.000Z");
    await emitDataArrival({
      userId: USER,
      kind: "weight",
      newestSampleAt: new Date("2026-07-14T22:00:00.000Z"),
      insertedCount: 1,
      source: "withings",
      now,
    });
    const payload = sendMock.mock.calls[0][1] as { localDate: string };
    expect(payload.localDate).toBe("2026-07-15");
  });
});
