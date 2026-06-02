/**
 * v1.10.0 QA — shared score-row helpers.
 *
 * Pins the "score the PREVIOUS UTC day" contract (the cron fires ~03 UTC, so
 * scoring the current UTC day would miss a just-completed day's data), the
 * noon-UTC measuredAt, the prefixed externalId, the idempotent upsert, and
 * the cohort tally / one-bad-user-does-not-block-the-rest guarantee of
 * `runScoreBatch`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const annotateMock = vi.fn();
vi.mock("@/lib/logging/context", () => ({
  annotate: (...args: unknown[]) => annotateMock(...args),
}));

import {
  scoreDayKey,
  scoreMeasuredAt,
  scoreExternalId,
  upsertScoreRow,
  runScoreBatch,
} from "../score-row";

beforeEach(() => vi.clearAllMocks());

describe("scoreDayKey — previous UTC day", () => {
  it("a 03:00 UTC run scores the prior calendar day", () => {
    // 04:45 Europe/Berlin (summer) ≈ 02:45 UTC; a 03:00 UTC tick is the cron
    // moment. The scored day must be the day that just ended.
    const now = new Date("2026-06-02T03:00:00Z");
    expect(scoreDayKey(now)).toBe("2026-06-01");
  });

  it("crosses a month boundary correctly", () => {
    const now = new Date("2026-07-01T02:50:00Z");
    expect(scoreDayKey(now)).toBe("2026-06-30");
  });

  it("crosses a year boundary correctly", () => {
    const now = new Date("2027-01-01T03:00:00Z");
    expect(scoreDayKey(now)).toBe("2026-12-31");
  });
});

describe("scoreMeasuredAt / scoreExternalId", () => {
  const now = new Date("2026-06-02T03:00:00Z");
  it("anchors the row at noon UTC on the scored (previous) day", () => {
    expect(scoreMeasuredAt(now).toISOString()).toBe("2026-06-01T12:00:00.000Z");
  });
  it("builds the prefixed externalId over the scored day", () => {
    expect(scoreExternalId("recovery:", now)).toBe("recovery:2026-06-01");
    expect(scoreExternalId("strain:", now)).toBe("strain:2026-06-01");
  });
});

describe("upsertScoreRow", () => {
  it("upserts on the (userId, type, COMPUTED, externalId) key with the prev-day stamp", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const prisma = {
      measurement: { upsert },
    } as unknown as Parameters<typeof upsertScoreRow>[0];
    const now = new Date("2026-06-02T03:00:00Z");

    await upsertScoreRow(prisma, {
      userId: "u1",
      type: "RECOVERY_SCORE",
      externalIdPrefix: "recovery:",
      score: 77,
      now,
    });

    const arg = upsert.mock.calls[0][0];
    expect(arg.where.userId_type_source_externalId).toEqual({
      userId: "u1",
      type: "RECOVERY_SCORE",
      source: "COMPUTED",
      externalId: "recovery:2026-06-01",
    });
    expect(arg.create).toMatchObject({
      type: "RECOVERY_SCORE",
      source: "COMPUTED",
      value: 77,
      unit: "score",
      externalId: "recovery:2026-06-01",
    });
    expect(arg.create.measuredAt.toISOString()).toBe(
      "2026-06-01T12:00:00.000Z",
    );
    expect(arg.update).toEqual({
      value: 77,
      measuredAt: arg.create.measuredAt,
    });
  });
});

describe("runScoreBatch", () => {
  const NOW = new Date("2026-06-02T03:00:00Z");

  it("tallies stored vs insufficient and annotates", async () => {
    const persist = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "stored" })
      .mockResolvedValueOnce({ outcome: "insufficient" })
      .mockResolvedValueOnce({ outcome: "stored" });

    const result = await runScoreBatch(
      ["a", "b", "c"],
      NOW,
      persist,
      "insights.recovery.compute",
    );

    expect(result).toEqual({
      considered: 3,
      stored: 2,
      insufficient: 1,
      errored: 0,
    });
    expect(annotateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.objectContaining({ name: "insights.recovery.compute" }),
      }),
    );
  });

  it("counts a per-user error and keeps processing the cohort", async () => {
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ outcome: "stored" });

    const result = await runScoreBatch(["a", "b"], NOW, persist, "x.compute");

    expect(result).toEqual({
      considered: 2,
      stored: 1,
      insufficient: 0,
      errored: 1,
    });
  });

  it("passes the run `now` through to the persist function", async () => {
    const persist = vi.fn().mockResolvedValue({ outcome: "stored" });
    await runScoreBatch(["a"], NOW, persist, "x.compute");
    expect(persist).toHaveBeenCalledWith("a", NOW);
  });
});
