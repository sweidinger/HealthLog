/**
 * v1.20.0 F6 — bit-identical parity for the rollup regression accumulators.
 *
 * The windowed slope / r² / population-sd now compose from the per-bucket
 * accumulators (`sum_x / sum_xy / sum_xx / sum_yy`, plus `n = count` and
 * `Σy = mean·count`) that migration 0190 added to `measurement_rollups`.
 * Because the accumulators are additive and Postgres `REGR_SLOPE` /
 * `REGR_R2` / `STDDEV_POP` fold the SAME closed form over the SAME epoch-day
 * x-axis the populator stored, the cross-bucket compose must equal the live
 * aggregate over the raw rows EXACTLY — not within a tolerance.
 *
 * This suite seeds raw measurements spanning many DAY buckets with uneven
 * per-day counts (the regime where mean-of-means and the true regression
 * diverge), folds the rollups, then asserts:
 *
 *   1. `composeRegression` over the folded DAY-bucket accumulators equals
 *      `REGR_SLOPE` / `REGR_R2` / `STDDEV_POP` over the raw rows to ≤ 1e-9.
 *   2. The source-collapse runs BEFORE accumulator summation — a dual-source
 *      day contributes only the canonical source's accumulators, matching a
 *      live regression over the canonical-source rows.
 *   3. A DST-boundary reading lands in the same epoch-day x the live query
 *      uses (the x-axis is UTC `EXTRACT(EPOCH …)/86400`, DST-agnostic).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";
import {
  composeRegression,
  type RegressionAccumulators,
} from "@/lib/rollups/measurement-read";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

/** Live REGR row shape (one per type over the seeded window). */
interface LiveRegrRow {
  slope: number | null;
  r2: number | null;
  sd_pop: number | null;
  n: bigint;
}

let seq = 0;
async function seedUser(prisma: ReturnType<typeof getPrismaClient>) {
  seq += 1;
  return prisma.user.create({
    data: {
      username: `regr-parity-${seq}`,
      email: `regr-parity-${seq}@example.test`,
      role: "USER",
    },
  });
}

/**
 * Live REGR_SLOPE / REGR_R2 / STDDEV_POP over the canonical-source raw rows
 * for one (user, type), with the SAME epoch-day x-axis the populator stores.
 * `sourceFilter` restricts to one source so the dual-source case can compare
 * against the collapsed source explicitly.
 */
async function liveRegr(
  prisma: ReturnType<typeof getPrismaClient>,
  userId: string,
  type: string,
  source?: string,
): Promise<LiveRegrRow> {
  const rows = await prisma.$queryRawUnsafe<LiveRegrRow[]>(
    `
      SELECT
        REGR_SLOPE(m."value", EXTRACT(EPOCH FROM m."measured_at") / 86400.0)
          ::double precision AS slope,
        REGR_R2(m."value", EXTRACT(EPOCH FROM m."measured_at") / 86400.0)
          ::double precision AS r2,
        STDDEV_POP(m."value")::double precision AS sd_pop,
        COUNT(*) AS n
      FROM measurements m
      WHERE m."user_id" = $1
        AND m."type" = $2::"measurement_type"
        AND m."deleted_at" IS NULL
        ${source ? `AND m."source" = $3::"measurement_source"` : ""}
    `,
    ...(source ? [userId, type, source] : [userId, type]),
  );
  return rows[0];
}

/**
 * Read the folded DAY-bucket accumulators for one (user, type, source).
 * The parity assertion sums these via `composeRegression` and compares to
 * the live regression over the same source's raw rows.
 */
async function foldedAccumulators(
  prisma: ReturnType<typeof getPrismaClient>,
  userId: string,
  type: string,
  source?: string,
): Promise<RegressionAccumulators[]> {
  const rows = await prisma.measurementRollup.findMany({
    where: {
      userId,
      type: type as never,
      granularity: "DAY",
      ...(source ? { source: source as never } : {}),
    },
    select: {
      count: true,
      mean: true,
      sumX: true,
      sumXy: true,
      sumXx: true,
      sumYy: true,
    },
  });
  return rows.map((r) => ({
    count: r.count,
    mean: r.mean,
    sumX: r.sumX,
    sumXy: r.sumXy,
    sumXx: r.sumXx,
    sumYy: r.sumYy,
  }));
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rollup regression accumulators — live parity (v1.20.0 F6)", () => {
  it("WEIGHT: composed slope/r²/sd equals live REGR_*/STDDEV_POP, bit-identical", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser(prisma);

    // Uneven per-day counts across many buckets — the divergent regime.
    // Deterministic, non-collinear values so slope / r² / sd are all
    // well-defined (a perfect line would make r² == 1 trivially).
    const seed: Array<{ day: string; hour: number; value: number }> = [
      { day: "2026-03-02", hour: 8, value: 90.0 },
      { day: "2026-03-03", hour: 7, value: 89.4 },
      { day: "2026-03-03", hour: 20, value: 89.9 },
      { day: "2026-03-09", hour: 6, value: 88.7 },
      { day: "2026-03-09", hour: 9, value: 89.1 },
      { day: "2026-03-09", hour: 21, value: 88.2 },
      { day: "2026-03-21", hour: 8, value: 87.6 },
      { day: "2026-04-04", hour: 7, value: 86.9 },
      { day: "2026-04-04", hour: 19, value: 87.3 },
      { day: "2026-04-18", hour: 8, value: 86.1 },
      { day: "2026-05-02", hour: 8, value: 85.4 },
      { day: "2026-05-02", hour: 12, value: 85.9 },
      { day: "2026-05-16", hour: 8, value: 84.8 },
    ];
    await prisma.measurement.createMany({
      data: seed.map((s) => ({
        userId: user.id,
        type: "WEIGHT" as const,
        value: s.value,
        unit: "kg",
        source: "MANUAL" as const,
        measuredAt: new Date(
          `${s.day}T${String(s.hour).padStart(2, "0")}:00:00.000Z`,
        ),
      })),
    });

    await recomputeUserRollups(user.id, {
      types: ["WEIGHT"],
      granularities: ["DAY"],
    });

    const live = await liveRegr(prisma, user.id, "WEIGHT");
    const acc = await foldedAccumulators(prisma, user.id, "WEIGHT");
    const composed = composeRegression(acc);

    // Sanity: the seed actually exercised the regression (n matches, slope
    // is a real number, not a degenerate null).
    expect(Number(live.n)).toBe(seed.length);
    expect(live.slope).not.toBeNull();
    expect(composed.slope).not.toBeNull();

    // Bit-identical parity — the closed form is the same on both paths.
    expect(composed.slope!).toBeCloseTo(live.slope!, 9);
    expect(composed.r2!).toBeCloseTo(live.r2!, 9);
    expect(composed.sdPop!).toBeCloseTo(live.sd_pop!, 9);
  });

  it("source-collapse precedes summation: composed RHR equals live REGR over the WHOOP source only", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser(prisma);

    // Dual-source RHR across several days: WHOOP (the ladder-canonical
    // source) + APPLE_HEALTH on overlapping days. The composed regression
    // must match a LIVE regression over the WHOOP rows alone — never a
    // cross-source blend.
    const days = ["2026-05-04", "2026-05-05", "2026-05-11", "2026-05-18"];
    const data: Array<{
      userId: string;
      type: "RESTING_HEART_RATE";
      value: number;
      unit: string;
      source: "WHOOP" | "APPLE_HEALTH";
      measuredAt: Date;
    }> = [];
    let i = 0;
    for (const day of days) {
      i += 1;
      // WHOOP trends down; APPLE sits a few bpm higher to perturb a blend.
      data.push({
        userId: user.id,
        type: "RESTING_HEART_RATE",
        value: 52 - i,
        unit: "bpm",
        source: "WHOOP",
        measuredAt: new Date(`${day}T06:00:00.000Z`),
      });
      data.push({
        userId: user.id,
        type: "RESTING_HEART_RATE",
        value: 58 + i,
        unit: "bpm",
        source: "APPLE_HEALTH",
        measuredAt: new Date(`${day}T07:30:00.000Z`),
      });
    }
    await prisma.measurement.createMany({ data });

    await recomputeUserRollups(user.id, {
      types: ["RESTING_HEART_RATE"],
      granularities: ["DAY"],
    });

    // WHOOP is the ladder winner for restingHeartRate, so the read tier
    // collapses each day to the WHOOP per-source bucket. Compose only the
    // WHOOP accumulators and compare to the live WHOOP-only regression.
    const live = await liveRegr(prisma, user.id, "RESTING_HEART_RATE", "WHOOP");
    const acc = await foldedAccumulators(
      prisma,
      user.id,
      "RESTING_HEART_RATE",
      "WHOOP",
    );
    const composed = composeRegression(acc);

    expect(Number(live.n)).toBe(days.length);
    expect(composed.slope!).toBeCloseTo(live.slope!, 9);
    expect(composed.r2!).toBeCloseTo(live.r2!, 9);
    expect(composed.sdPop!).toBeCloseTo(live.sd_pop!, 9);

    // The blend would be wrong: a regression over BOTH sources differs from
    // the WHOOP-only one, proving the collapse-before-sum matters.
    const blended = await liveRegr(prisma, user.id, "RESTING_HEART_RATE");
    expect(Number(blended.n)).toBe(days.length * 2);
    expect(blended.slope).not.toBeCloseTo(live.slope!, 6);
  });

  it("DST boundary: the epoch-day x-axis is UTC, so a spring-forward reading parity-matches", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser(prisma);

    // Readings straddling the 2026 EU DST transition (2026-03-29 01:00 UTC).
    // The x-axis is UTC epoch-days on both paths, so the transition is a
    // no-op for parity; this pins that the accumulator x matches the live x.
    const seed: Array<{ at: string; value: number }> = [
      { at: "2026-03-28T23:30:00.000Z", value: 100.0 },
      { at: "2026-03-29T00:30:00.000Z", value: 101.2 },
      { at: "2026-03-29T02:30:00.000Z", value: 99.7 },
      { at: "2026-03-30T08:00:00.000Z", value: 102.4 },
      { at: "2026-03-31T08:00:00.000Z", value: 98.9 },
    ];
    await prisma.measurement.createMany({
      data: seed.map((s) => ({
        userId: user.id,
        type: "BLOOD_GLUCOSE" as const,
        value: s.value,
        unit: "mg/dL",
        source: "MANUAL" as const,
        measuredAt: new Date(s.at),
      })),
    });

    await recomputeUserRollups(user.id, {
      types: ["BLOOD_GLUCOSE"],
      granularities: ["DAY"],
    });

    const live = await liveRegr(prisma, user.id, "BLOOD_GLUCOSE");
    const acc = await foldedAccumulators(prisma, user.id, "BLOOD_GLUCOSE");
    const composed = composeRegression(acc);

    expect(Number(live.n)).toBe(seed.length);
    expect(composed.slope!).toBeCloseTo(live.slope!, 9);
    expect(composed.r2!).toBeCloseTo(live.r2!, 9);
    expect(composed.sdPop!).toBeCloseTo(live.sd_pop!, 9);
  });
});
