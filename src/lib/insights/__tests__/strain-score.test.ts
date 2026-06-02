/**
 * v1.10.0 — computed scores (WX-E). Strain-score engine + persistence.
 *
 * The Strain score is a Banister-TRIMP cardio-load proxy from the
 * per-workout HR series + active energy. These tests pin:
 *   - the Banister gender-weighted exponential TRIMP math,
 *   - the saturating 0–100 map,
 *   - the TRIMP path + the active-energy fallback,
 *   - the per-day idempotency key + insufficient-data gate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  strainDayKey,
  strainExternalId,
  strainMeasuredAt,
  tanakaHrMax,
  banisterTrimp,
  saturateToScore,
  persistStrainScore,
  STRAIN_SCORE_EXTERNAL_ID_PREFIX,
} from "../strain-score";

const NOW = new Date("2026-06-02T08:30:00Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("strain-score helpers", () => {
  it("keys the day + externalId by the UTC calendar day", () => {
    expect(strainDayKey(NOW)).toBe("2026-06-02");
    expect(strainExternalId(NOW)).toBe(
      `${STRAIN_SCORE_EXTERNAL_ID_PREFIX}2026-06-02`,
    );
  });

  it("anchors the canonical timestamp at noon UTC", () => {
    expect(strainMeasuredAt(NOW).toISOString()).toBe(
      "2026-06-02T12:00:00.000Z",
    );
  });

  it("uses the Tanaka HRmax formula", () => {
    expect(tanakaHrMax(40)).toBeCloseTo(208 - 0.7 * 40, 6); // 180
  });
});

describe("banisterTrimp", () => {
  const hrRest = 50;
  const hrMax = 190;
  const sex = "MALE" as const;

  it("returns 0 for a series with fewer than two usable HR samples", () => {
    expect(banisterTrimp([{ t: NOW.toISOString(), hr: 150 }], hrRest, hrMax, sex)).toBe(
      0,
    );
  });

  it("accumulates a positive TRIMP for a sustained elevated series", () => {
    const samples = [
      { t: "2026-06-02T08:00:00.000Z", hr: 150 },
      { t: "2026-06-02T08:30:00.000Z", hr: 150 },
      { t: "2026-06-02T09:00:00.000Z", hr: 150 },
    ];
    const trimp = banisterTrimp(samples, hrRest, hrMax, sex);
    expect(trimp).toBeGreaterThan(0);
  });

  it("scores a harder hour above an easier hour", () => {
    const easy = [
      { t: "2026-06-02T08:00:00.000Z", hr: 100 },
      { t: "2026-06-02T09:00:00.000Z", hr: 100 },
    ];
    const hard = [
      { t: "2026-06-02T08:00:00.000Z", hr: 170 },
      { t: "2026-06-02T09:00:00.000Z", hr: 170 },
    ];
    expect(banisterTrimp(hard, hrRest, hrMax, sex)).toBeGreaterThan(
      banisterTrimp(easy, hrRest, hrMax, sex),
    );
  });

  it("ignores samples below resting HR (no negative impulse)", () => {
    const below = [
      { t: "2026-06-02T08:00:00.000Z", hr: 45 },
      { t: "2026-06-02T09:00:00.000Z", hr: 45 },
    ];
    expect(banisterTrimp(below, hrRest, hrMax, sex)).toBe(0);
  });

  it("returns 0 when HRmax <= HRrest (degenerate profile)", () => {
    const samples = [
      { t: "2026-06-02T08:00:00.000Z", hr: 100 },
      { t: "2026-06-02T09:00:00.000Z", hr: 100 },
    ];
    expect(banisterTrimp(samples, 190, 190, sex)).toBe(0);
  });
});

describe("saturateToScore", () => {
  it("is 0 at zero load and rises monotonically toward 100", () => {
    expect(saturateToScore(0, 150)).toBe(0);
    const a = saturateToScore(50, 150);
    const b = saturateToScore(150, 150);
    const c = saturateToScore(600, 150);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(c).toBeLessThanOrEqual(100);
  });
});

function makePrisma(opts: {
  energy?: number[];
  workouts?: Array<{ id: string; samples: { samples: unknown } | null }>;
  rhr?: number | null;
  gender?: string;
  dateOfBirth?: Date | null;
}) {
  const energyRows = (opts.energy ?? []).map((value, i) => ({
    value,
    id: `e${i}`,
  }));
  const measurementFindMany = vi.fn().mockResolvedValue(energyRows);
  const measurementFindFirst = vi
    .fn()
    .mockResolvedValue(opts.rhr == null ? null : { value: opts.rhr });
  const workoutFindMany = vi.fn().mockResolvedValue(opts.workouts ?? []);
  const upsert = vi.fn().mockResolvedValue({});
  const findUnique = vi.fn().mockResolvedValue({
    dateOfBirth:
      "dateOfBirth" in opts
        ? opts.dateOfBirth
        : new Date("1986-01-01T00:00:00Z"),
    gender: opts.gender ?? "MALE",
  });
  return {
    prisma: {
      measurement: {
        findMany: measurementFindMany,
        findFirst: measurementFindFirst,
        upsert,
      },
      workout: { findMany: workoutFindMany },
      user: { findUnique },
    } as unknown as Parameters<typeof persistStrainScore>[0],
    upsert,
  };
}

describe("persistStrainScore", () => {
  it("stores a COMPUTED STRAIN_SCORE row via the TRIMP path", async () => {
    const { prisma, upsert } = makePrisma({
      rhr: 50,
      workouts: [
        {
          id: "w1",
          samples: {
            samples: [
              { t: "2026-06-02T08:00:00.000Z", hr: 150 },
              { t: "2026-06-02T08:30:00.000Z", hr: 155 },
              { t: "2026-06-02T09:00:00.000Z", hr: 150 },
            ],
          },
        },
      ],
    });

    const result = await persistStrainScore(prisma, "user-1", NOW);

    expect(result.outcome).toBe("stored");
    expect(result.reason).toBe("trimp");
    expect(result.score).toBeGreaterThan(0);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where.userId_type_source_externalId).toEqual({
      userId: "user-1",
      type: "STRAIN_SCORE",
      source: "COMPUTED",
      externalId: "strain:2026-06-02",
    });
    expect(arg.create).toMatchObject({
      type: "STRAIN_SCORE",
      source: "COMPUTED",
      unit: "score",
    });
  });

  it("falls back to the active-energy proxy when no HR series is usable", async () => {
    const { prisma, upsert } = makePrisma({
      rhr: 50,
      energy: [300, 250],
      workouts: [], // no workouts → no TRIMP
    });

    const result = await persistStrainScore(prisma, "user-1", NOW);

    expect(result.outcome).toBe("stored");
    expect(result.reason).toBe("active_energy_fallback");
    expect(result.score).toBeGreaterThan(0);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("gates when there is a workout but the profile yields no HRmax", async () => {
    const { prisma, upsert } = makePrisma({
      rhr: 50,
      dateOfBirth: null, // no age → no Tanaka HRmax
      workouts: [
        {
          id: "w1",
          samples: {
            samples: [
              { t: "2026-06-02T08:00:00.000Z", hr: 150 },
              { t: "2026-06-02T09:00:00.000Z", hr: 150 },
            ],
          },
        },
      ],
      energy: [], // no active-energy fallback either
    });

    const result = await persistStrainScore(prisma, "user-1", NOW);

    expect(result.outcome).toBe("insufficient");
    expect(result.reason).toBe("insufficient_profile");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("writes NOTHING when there is no usable input at all", async () => {
    const { prisma, upsert } = makePrisma({
      rhr: 50,
      workouts: [],
      energy: [],
    });

    const result = await persistStrainScore(prisma, "user-1", NOW);

    expect(result.outcome).toBe("insufficient");
    expect(result.reason).toBe("insufficient_inputs");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("is idempotent per user per day — re-runs upsert the same key", async () => {
    const { prisma, upsert } = makePrisma({
      rhr: 50,
      energy: [400],
    });

    await persistStrainScore(prisma, "user-1", NOW);
    await persistStrainScore(prisma, "user-1", NOW);

    expect(upsert).toHaveBeenCalledTimes(2);
    const firstKey =
      upsert.mock.calls[0][0].where.userId_type_source_externalId;
    const secondKey =
      upsert.mock.calls[1][0].where.userId_type_source_externalId;
    expect(secondKey).toEqual(firstKey);
  });
});
