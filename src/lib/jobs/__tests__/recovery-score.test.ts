/**
 * v1.10.0 — computed scores (WX-C). Recovery-score nightly run logic.
 *
 * Drives `runRecoveryScore` with a stubbed prisma + a mocked per-user
 * persist so the tally (stored / insufficient / errored) and the
 * one-bad-user-does-not-block-the-cohort guarantee are pinned without a DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const persistMock = vi.fn();
const annotateMock = vi.fn();

vi.mock("@/lib/insights/recovery-score", () => ({
  persistRecoveryScore: (...args: unknown[]) => persistMock(...args),
}));
vi.mock("@/lib/logging/context", () => ({
  annotate: (...args: unknown[]) => annotateMock(...args),
}));

import {
  runRecoveryScore,
  findRecoveryScoreCandidates,
  RECOVERY_SCORE_RECENCY_DAYS,
} from "../recovery-score";

const NOW = new Date("2026-06-02T08:00:00Z");

function makePrisma(userIds: string[]) {
  const findMany = vi
    .fn()
    .mockResolvedValue(userIds.map((userId) => ({ userId })));
  return {
    prisma: { measurement: { findMany } } as unknown as Parameters<
      typeof runRecoveryScore
    >[0],
    findMany,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("findRecoveryScoreCandidates", () => {
  it("queries live recovery-input rows inside the recency window", async () => {
    const { prisma, findMany } = makePrisma(["a", "b"]);
    const ids = await findRecoveryScoreCandidates(prisma, NOW, 100);

    expect(ids).toEqual(["a", "b"]);
    const where = findMany.mock.calls[0][0].where;
    expect(where.type.in).toEqual(
      expect.arrayContaining([
        "RESTING_HEART_RATE",
        "HEART_RATE_VARIABILITY",
        "SLEEP_DURATION",
        "RESPIRATORY_RATE",
      ]),
    );
    expect(where.deletedAt).toBeNull();
    // recency floor is `now - RECENCY_DAYS`.
    const expectedSince = new Date(
      NOW.getTime() - RECOVERY_SCORE_RECENCY_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(where.measuredAt.gte.getTime()).toBe(expectedSince.getTime());
    expect(findMany.mock.calls[0][0].distinct).toEqual(["userId"]);
  });
});

describe("runRecoveryScore", () => {
  it("tallies stored vs insufficient across the cohort", async () => {
    const { prisma } = makePrisma(["a", "b", "c"]);
    persistMock
      .mockResolvedValueOnce({ outcome: "stored", score: 70 })
      .mockResolvedValueOnce({ outcome: "insufficient", score: null })
      .mockResolvedValueOnce({ outcome: "stored", score: 55 });

    const result = await runRecoveryScore(prisma, { now: NOW });

    expect(result).toEqual({
      considered: 3,
      stored: 2,
      insufficient: 1,
      errored: 0,
    });
    expect(persistMock).toHaveBeenCalledTimes(3);
  });

  it("counts a per-user error and keeps processing the rest", async () => {
    const { prisma } = makePrisma(["a", "b"]);
    persistMock
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ outcome: "stored", score: 80 });

    const result = await runRecoveryScore(prisma, { now: NOW });

    expect(result).toEqual({
      considered: 2,
      stored: 1,
      insufficient: 0,
      errored: 1,
    });
  });

  it("annotates the pass with the tally", async () => {
    const { prisma } = makePrisma(["a"]);
    persistMock.mockResolvedValue({ outcome: "stored", score: 90 });

    await runRecoveryScore(prisma, { now: NOW });

    expect(annotateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.objectContaining({ name: "insights.recovery.compute" }),
      }),
    );
  });
});
