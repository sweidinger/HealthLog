/**
 * v1.10.0 — computed scores (WX-E). Stress-score engine + persistence.
 *
 * The Stress score is an HONEST HRV-derived proxy (Apple Watch has no EDA
 * sensor). These tests pin:
 *   - the proxy math (HRV suppression below baseline → higher stress),
 *   - the per-day idempotency-key + canonical-timestamp helpers,
 *   - the insufficient-data gates (too few intra-day samples; no baseline),
 *   - the "store on ok, write nothing on gate" persistence + idempotency.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const computeVitalsBaselineMock = vi.fn();
vi.mock("@/lib/insights/derived/baseline", () => ({
  computeVitalsBaseline: (...args: unknown[]) =>
    computeVitalsBaselineMock(...args),
}));

import {
  stressDayKey,
  stressExternalId,
  stressMeasuredAt,
  stressProxyFromSdnn,
  persistStressScore,
  STRESS_SCORE_EXTERNAL_ID_PREFIX,
  STRESS_MIN_INTRADAY_SAMPLES,
} from "../stress-score";

const NOW = new Date("2026-06-02T08:30:00Z");

function okBaseline(center: number, spread: number) {
  return {
    status: "ok" as const,
    value: { center, low: center - spread, high: center + spread, spread },
  };
}

function makePrisma(sdnnValues: number[]) {
  const sdnnRows = sdnnValues.map((value, i) => ({ value, id: `s${i}` }));
  const findMany = vi.fn().mockResolvedValue(sdnnRows);
  const upsert = vi.fn().mockResolvedValue({});
  const findUnique = vi
    .fn()
    .mockResolvedValue({ dateOfBirth: null, gender: "MALE", heightCm: 180 });
  return {
    prisma: {
      measurement: { findMany, upsert },
      user: { findUnique },
    } as unknown as Parameters<typeof persistStressScore>[0],
    findMany,
    upsert,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("stress-score helpers", () => {
  it("keys the day + externalId by the UTC calendar day", () => {
    expect(stressDayKey(NOW)).toBe("2026-06-02");
    expect(stressExternalId(NOW)).toBe(
      `${STRESS_SCORE_EXTERNAL_ID_PREFIX}2026-06-02`,
    );
  });

  it("anchors the canonical timestamp at noon UTC on the scored day", () => {
    expect(stressMeasuredAt(NOW).toISOString()).toBe(
      "2026-06-02T12:00:00.000Z",
    );
  });
});

describe("stressProxyFromSdnn — HRV suppression → higher stress", () => {
  it("scores 0 when SDNN is at or above baseline (no inferred stress)", () => {
    expect(stressProxyFromSdnn(60, 60, 10)).toBe(0);
    expect(stressProxyFromSdnn(80, 60, 10)).toBe(0);
  });

  it("rises as SDNN drops below baseline", () => {
    // One spread below baseline → ~50 stress (recovery scorer gives ~50).
    expect(stressProxyFromSdnn(50, 60, 10)).toBeGreaterThanOrEqual(45);
    expect(stressProxyFromSdnn(50, 60, 10)).toBeLessThanOrEqual(55);
    // Two spreads below → ~100 stress.
    expect(stressProxyFromSdnn(40, 60, 10)).toBeGreaterThanOrEqual(95);
  });

  it("is monotone — lower SDNN never yields lower stress", () => {
    const a = stressProxyFromSdnn(55, 60, 10);
    const b = stressProxyFromSdnn(45, 60, 10);
    expect(b).toBeGreaterThanOrEqual(a);
  });
});

describe("persistStressScore", () => {
  it("stores a COMPUTED STRESS_SCORE row when inputs are sufficient", async () => {
    const { prisma, upsert } = makePrisma([40, 42, 38, 41]); // mean 40.25
    computeVitalsBaselineMock.mockResolvedValue(okBaseline(60, 10));

    const result = await persistStressScore(prisma, "user-1", NOW);

    expect(result.outcome).toBe("stored");
    expect(result.score).toBeGreaterThan(0);
    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where.userId_type_source_externalId).toEqual({
      userId: "user-1",
      type: "STRESS_SCORE",
      source: "COMPUTED",
      externalId: "stress:2026-06-02",
    });
    expect(arg.create).toMatchObject({
      type: "STRESS_SCORE",
      source: "COMPUTED",
      unit: "score",
      externalId: "stress:2026-06-02",
    });
  });

  it("writes NOTHING when there are too few intra-day samples", async () => {
    const { prisma, upsert } = makePrisma(
      Array(STRESS_MIN_INTRADAY_SAMPLES - 1).fill(50),
    );
    computeVitalsBaselineMock.mockResolvedValue(okBaseline(60, 10));

    const result = await persistStressScore(prisma, "user-1", NOW);

    expect(result.outcome).toBe("insufficient");
    expect(result.reason).toBe("insufficient_intraday_samples");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("writes NOTHING when the SDNN baseline is not usable", async () => {
    const { prisma, upsert } = makePrisma([40, 42, 38, 41]);
    computeVitalsBaselineMock.mockResolvedValue({ status: "insufficient" });

    const result = await persistStressScore(prisma, "user-1", NOW);

    expect(result.outcome).toBe("insufficient");
    expect(result.reason).toBe("insufficient_baseline");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("is idempotent per user per day — re-runs upsert the same key", async () => {
    const { prisma, upsert } = makePrisma([40, 42, 38, 41]);
    computeVitalsBaselineMock.mockResolvedValue(okBaseline(60, 10));

    await persistStressScore(prisma, "user-1", NOW);
    await persistStressScore(prisma, "user-1", NOW);

    expect(upsert).toHaveBeenCalledTimes(2);
    const firstKey =
      upsert.mock.calls[0][0].where.userId_type_source_externalId;
    const secondKey =
      upsert.mock.calls[1][0].where.userId_type_source_externalId;
    expect(secondKey).toEqual(firstKey);
  });
});
