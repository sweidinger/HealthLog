/**
 * v1.28.37 — real-Postgres integration coverage for the step-consolidation
 * repair (`runStepConsolidationRepairForUser`). Mirrors the
 * `consolidate-legacy-steps` fixture: the testcontainer is hot before this
 * file loads, so each case truncates + seeds + repairs.
 *
 * Pins the contracts the unit mocks can't:
 *   - tombstoned GOOGLE_HEALTH + FITBIT `stats:steps:<day>` rows within the
 *     retention horizon are resurrected (both providers, parity);
 *   - a tombstone older than the 75-day horizon is left alone;
 *   - the shadow MANUAL `stats:HK…:<day>` total is removed only where a live
 *     provider row for the same day returns;
 *   - a re-run converges to zero (no double-resurrect / no duplicate).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { runStepConsolidationRepairForUser } from "@/lib/jobs/step-consolidation-repair";
import { TOMBSTONE_RETENTION_DAYS } from "@/lib/auth/native-client";

const TEST_USER_ID = "user-step-repair";
const DAY_MS = 24 * 60 * 60 * 1000;

/** A tombstone timestamp `daysAgo` days in the past. */
function tombstonedAt(daysAgo: number): Date {
  return new Date(Date.now() - daysAgo * DAY_MS);
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "step-repair",
      email: "step-repair@example.test",
      timezone: "Europe/Berlin",
    },
  });
});

describe("runStepConsolidationRepairForUser (real Postgres)", () => {
  it("resurrects tombstoned Google Health AND Fitbit daily totals within the horizon", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 8123,
          unit: "steps",
          source: "GOOGLE_HEALTH",
          measuredAt: new Date("2026-05-16T12:00:00.000Z"),
          externalId: "stats:steps:2026-05-16",
          deletedAt: tombstonedAt(3),
        },
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 9456,
          unit: "steps",
          source: "FITBIT",
          measuredAt: new Date("2026-05-17T12:00:00.000Z"),
          externalId: "stats:steps:2026-05-17",
          deletedAt: tombstonedAt(3),
        },
      ],
    });

    const summary = await runStepConsolidationRepairForUser(TEST_USER_ID);

    expect(summary.rowsResurrected).toBe(2);
    expect(summary.wedgeSkipped).toBe(0);
    expect(summary.failures).toBe(0);

    const live = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "ACTIVITY_STEPS", deletedAt: null },
      orderBy: { measuredAt: "asc" },
    });
    expect(live).toHaveLength(2);
    expect(live.map((r) => r.source)).toEqual(["GOOGLE_HEALTH", "FITBIT"]);
    expect(live.map((r) => r.value)).toEqual([8123, 9456]);
  });

  it("does not resurrect a tombstone older than the retention horizon", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "ACTIVITY_STEPS",
        value: 5000,
        unit: "steps",
        source: "GOOGLE_HEALTH",
        measuredAt: new Date("2026-01-01T12:00:00.000Z"),
        externalId: "stats:steps:2026-01-01",
        deletedAt: tombstonedAt(TOMBSTONE_RETENTION_DAYS + 10),
      },
    });

    const summary = await runStepConsolidationRepairForUser(TEST_USER_ID);
    expect(summary.rowsResurrected).toBe(0);

    const live = await prisma.measurement.count({
      where: { userId: TEST_USER_ID, type: "ACTIVITY_STEPS", deletedAt: null },
    });
    expect(live).toBe(0);
  });

  it("removes the shadow MANUAL mint where a live provider row returns, and leaves it where none does", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.createMany({
      data: [
        // Day A: tombstoned Google row + shadow MANUAL mint → resurrect + remove mint.
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 8000,
          unit: "steps",
          source: "GOOGLE_HEALTH",
          measuredAt: new Date("2026-05-16T12:00:00.000Z"),
          externalId: "stats:steps:2026-05-16",
          deletedAt: tombstonedAt(2),
        },
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 8000,
          unit: "steps",
          source: "MANUAL",
          measuredAt: new Date("2026-05-16T11:00:00.000Z"),
          externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-05-16",
        },
        // Day B: a MANUAL mint with NO provider row → genuine Apple-legacy, keep it.
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 4200,
          unit: "steps",
          source: "MANUAL",
          measuredAt: new Date("2026-05-18T11:00:00.000Z"),
          externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-05-18",
        },
      ],
    });

    const summary = await runStepConsolidationRepairForUser(TEST_USER_ID);

    expect(summary.rowsResurrected).toBe(1);
    expect(summary.manualMintsRemoved).toBe(1);

    // Day A: Google live, MANUAL mint tombstoned.
    const dayA = await prisma.measurement.findMany({
      where: {
        userId: TEST_USER_ID,
        type: "ACTIVITY_STEPS",
        externalId: {
          in: [
            "stats:steps:2026-05-16",
            "stats:HKQuantityTypeIdentifierStepCount:2026-05-16",
          ],
        },
      },
    });
    const googleA = dayA.find((r) => r.source === "GOOGLE_HEALTH");
    const manualA = dayA.find((r) => r.source === "MANUAL");
    expect(googleA?.deletedAt).toBeNull();
    expect(manualA?.deletedAt).not.toBeNull();

    // Day B: the standalone MANUAL mint is untouched (still live).
    const manualB = await prisma.measurement.findFirst({
      where: {
        userId: TEST_USER_ID,
        source: "MANUAL",
        externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-05-18",
      },
    });
    expect(manualB?.deletedAt).toBeNull();
  });

  it("converges — a second run resurrects nothing and does not double-touch", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "ACTIVITY_STEPS",
        value: 6000,
        unit: "steps",
        source: "GOOGLE_HEALTH",
        measuredAt: new Date("2026-05-16T12:00:00.000Z"),
        externalId: "stats:steps:2026-05-16",
        deletedAt: tombstonedAt(1),
      },
    });

    const first = await runStepConsolidationRepairForUser(TEST_USER_ID);
    expect(first.rowsResurrected).toBe(1);

    const second = await runStepConsolidationRepairForUser(TEST_USER_ID);
    expect(second.rowsResurrected).toBe(0);
    expect(second.wedgeSkipped).toBe(0);
    expect(second.manualMintsRemoved).toBe(0);

    // Exactly one live row — no duplicate minted by the resurrect path.
    const rows = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "ACTIVITY_STEPS" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].deletedAt).toBeNull();
    expect(rows[0].value).toBe(6000);
  });
});
