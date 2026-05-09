/**
 * Integration regression for the "BD-Zielbereich" / BP-in-target tile.
 *
 * Marc reported (v1.4.16 marathon) that the dashboard tile rendered
 * 0 % despite multiple BP readings clearly inside the well-controlled
 * range. v1.4.15 A4 had restructured the calculation but kept the
 * ESH 2023 narrow-band semantics (`sysLow <= sys <= sysHigh AND diaLow
 * <= dia <= diaHigh`) — which collapses to 0 % for any user whose
 * readings sit BELOW the goal band, which is the most common case for
 * normotensive HealthLog users.
 *
 * v1.4.16 A2 changes semantics to a one-sided "at or below ceiling
 * with a hypotension floor" check. This test seeds a representative
 * mix of readings against the real Postgres testcontainer + Prisma
 * client and asserts the helper produces the expected percentage,
 * guarding against future regressions where someone re-introduces a
 * narrow-band check inline (we have 6 historical call sites — easy to
 * miss one in review).
 *
 * Also covers the null-tolerance regression (NaN / out-of-floor) so
 * the tile never crashes silently to 0 % from edge-case input.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { computeBpInTargetPct } from "@/lib/analytics/bp-in-target";
import { getBpTargets } from "@/lib/analytics/bp-targets";

import { getPrismaClient, truncateAllTables } from "./setup";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("BP-in-target % — production data shape", () => {
  it("computes a non-zero % for a normotensive user born under 65", async () => {
    const prisma = getPrismaClient();

    // Marc's actual production readings (anonymised but timestamps + values
    // verbatim so a future reviewer can re-derive the expected count by
    // hand from the test fixture). DOB: 1985-07-09 — under 65, so target
    // is sysHigh = 129, diaHigh = 79.
    const user = await prisma.user.create({
      data: {
        username: "bp-in-target-fixture",
        email: "bp-in-target@example.test",
        dateOfBirth: new Date("1985-07-09"),
      },
    });

    const seedReadings: Array<{
      sys: number;
      dia: number;
      measuredAt: string;
    }> = [
      { sys: 117, dia: 79, measuredAt: "2026-05-08T07:38:22Z" }, // IN
      { sys: 122, dia: 86, measuredAt: "2026-05-03T21:22:02Z" }, // OUT (dia)
      { sys: 108, dia: 76, measuredAt: "2026-05-03T05:51:45Z" }, // IN
      { sys: 106, dia: 73, measuredAt: "2026-05-03T05:50:55Z" }, // IN
      { sys: 127, dia: 86, measuredAt: "2026-04-20T05:57:42Z" }, // OUT (dia)
      { sys: 115, dia: 78, measuredAt: "2026-04-18T06:59:29Z" }, // IN
      { sys: 108, dia: 75, measuredAt: "2026-04-16T05:24:51Z" }, // IN
      { sys: 124, dia: 82, measuredAt: "2026-04-15T05:34:35Z" }, // OUT (dia)
      { sys: 126, dia: 80, measuredAt: "2026-04-15T05:33:44Z" }, // OUT (dia)
      { sys: 133, dia: 95, measuredAt: "2026-04-15T20:52:26Z" }, // OUT (both)
    ];

    // Seed both sys and dia rows at the same `measuredAt` so the helper's
    // 5-minute pairing gate accepts every pair. This mirrors how the
    // measurement form writes paired BP rows.
    for (const r of seedReadings) {
      const at = new Date(r.measuredAt);
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "BLOOD_PRESSURE_SYS",
          value: r.sys,
          unit: "mmHg",
          measuredAt: at,
        },
      });
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "BLOOD_PRESSURE_DIA",
          value: r.dia,
          unit: "mmHg",
          measuredAt: at,
        },
      });
    }

    const sysData = await prisma.measurement.findMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_SYS" },
      select: { measuredAt: true, value: true },
    });
    const diaData = await prisma.measurement.findMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_DIA" },
      select: { measuredAt: true, value: true },
    });

    const targets = getBpTargets(user.dateOfBirth);
    expect(targets).not.toBeNull();
    const result = computeBpInTargetPct(sysData, diaData, targets!);
    expect(result).not.toBeNull();
    expect(result!.pairs).toBe(10);
    // 5 of 10 paired readings are at or below the ceiling and above
    // the hypotension floor — see the `IN`/`OUT` annotations above.
    // Pre-v1.4.16 (narrow-band semantics) would have reported 0 %.
    expect(result!.pct).toBe(50);
  });

  it("returns null for a user with no BP measurements (tile renders 'no data')", async () => {
    const prisma = getPrismaClient();

    const user = await prisma.user.create({
      data: {
        username: "bp-empty-fixture",
        email: "bp-empty@example.test",
        dateOfBirth: new Date("1985-07-09"),
      },
    });

    const sysData = await prisma.measurement.findMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_SYS" },
      select: { measuredAt: true, value: true },
    });
    const diaData = await prisma.measurement.findMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_DIA" },
      select: { measuredAt: true, value: true },
    });

    const targets = getBpTargets(user.dateOfBirth);
    expect(computeBpInTargetPct(sysData, diaData, targets!)).toBeNull();
  });

  /**
   * Regression: a user with sys readings but missing dia (e.g., import
   * partial-failure where only sys rows were written) must NOT crash
   * the helper or silently return 0. We expect `null` so the dashboard
   * tile renders the "no data" empty state.
   */
  it("returns null when only sys readings exist (no dia to pair against)", async () => {
    const prisma = getPrismaClient();

    const user = await prisma.user.create({
      data: {
        username: "bp-sys-only-fixture",
        email: "bp-sys-only@example.test",
        dateOfBirth: new Date("1985-07-09"),
      },
    });

    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "BLOOD_PRESSURE_SYS",
        value: 122,
        unit: "mmHg",
        measuredAt: new Date("2026-05-08T08:00:00Z"),
      },
    });

    const sysData = await prisma.measurement.findMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_SYS" },
      select: { measuredAt: true, value: true },
    });
    const diaData = await prisma.measurement.findMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_DIA" },
      select: { measuredAt: true, value: true },
    });

    const targets = getBpTargets(user.dateOfBirth);
    expect(computeBpInTargetPct(sysData, diaData, targets!)).toBeNull();
  });

  /**
   * Regression: a hypotensive reading (sys 80, dia 50) is NOT
   * "well-controlled" — it's symptomatic low BP. The helper must mark
   * it OUT of target despite being below the ceiling. The clinical
   * floor (sys >= 90, dia >= 50) is what guards this.
   */
  it("excludes symptomatic-hypotension readings from the in-target count", async () => {
    const prisma = getPrismaClient();

    const user = await prisma.user.create({
      data: {
        username: "bp-hypo-fixture",
        email: "bp-hypo@example.test",
        dateOfBirth: new Date("1985-07-09"),
      },
    });

    const seedReadings: Array<{ sys: number; dia: number }> = [
      { sys: 80, dia: 45 }, // hypotensive — out
      { sys: 122, dia: 75 }, // normal — in
    ];

    for (const [i, r] of seedReadings.entries()) {
      const at = new Date(`2026-05-0${i + 1}T08:00:00Z`);
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "BLOOD_PRESSURE_SYS",
          value: r.sys,
          unit: "mmHg",
          measuredAt: at,
        },
      });
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "BLOOD_PRESSURE_DIA",
          value: r.dia,
          unit: "mmHg",
          measuredAt: at,
        },
      });
    }

    const sysData = await prisma.measurement.findMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_SYS" },
      select: { measuredAt: true, value: true },
    });
    const diaData = await prisma.measurement.findMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_DIA" },
      select: { measuredAt: true, value: true },
    });

    const targets = getBpTargets(user.dateOfBirth);
    const result = computeBpInTargetPct(sysData, diaData, targets!);
    expect(result).toEqual({ pct: 50, pairs: 2 });
  });
});
