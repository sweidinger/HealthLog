/**
 * v1.21.0 (NEW-B B-2) — the Coach illness-scores block.
 *
 * The Coach illness CONTEXT block carries only labels + lifecycle + dates; this
 * block surfaces the computed retrospective the illness card shows (recovery-
 * gap, gap-driver, nadir, pre-onset, red flags) for the most relevant episode,
 * read-only and coverage-gated. These guards assert the gating, the
 * active-wins-over-resolved selection, the finding compaction, and that a
 * withheld (insufficient) episode yields null — never a fabricated number.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const isIllnessEnabled = vi.fn();
const computeEpisodeCorrelation = vi.fn();
const findUnique = vi.fn();
const findFirst = vi.fn();

vi.mock("@/lib/illness/gate", () => ({
  isIllnessEnabled: (userId: string) => isIllnessEnabled(userId),
}));
vi.mock("@/lib/illness/correlation-read", () => ({
  computeEpisodeCorrelation: (...args: unknown[]) =>
    computeEpisodeCorrelation(...args),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: (a: unknown) => findUnique(a) },
    illnessEpisode: { findFirst: (a: unknown) => findFirst(a) },
  },
}));

import { buildIllnessScores } from "@/lib/ai/coach/illness-snapshot";

const ACTIVE = {
  id: "ep-active",
  label: "flu",
  type: "INFECTION",
  onsetAt: new Date("2026-06-10T00:00:00Z"),
  resolvedAt: null,
  lifecycle: "ACTIVE",
};
const RESOLVED = {
  id: "ep-resolved",
  label: "cold",
  type: "INFECTION",
  onsetAt: new Date("2026-05-01T00:00:00Z"),
  resolvedAt: new Date("2026-05-08T00:00:00Z"),
  lifecycle: "RESOLVED",
};

function okDerived() {
  return {
    status: "ok" as const,
    value: {
      episodeId: "ep-active",
      recoveryGapDays: 4,
      gapDriverType: "RESTING_HEART_RATE",
      nadir: [
        {
          type: "HEART_RATE_VARIABILITY",
          day: "2026-06-12",
          value: 30,
          baselineCenter: 55,
          deviationSd: -2.43,
          direction: "below" as const,
          adverse: true,
        },
        {
          type: "WEIGHT",
          day: "2026-06-12",
          value: 80,
          baselineCenter: 81,
          deviationSd: -0.5,
          direction: "below" as const,
          adverse: false,
        },
      ],
      preOnset: [],
      redFlags: [
        {
          type: "BODY_TEMPERATURE",
          reason: "sustained_fever" as const,
          worstValue: 38.9,
          days: 3,
        },
      ],
    },
  };
}

describe("buildIllnessScores", () => {
  beforeEach(() => {
    isIllnessEnabled.mockReset();
    computeEpisodeCorrelation.mockReset();
    findUnique.mockReset();
    findFirst.mockReset();
    isIllnessEnabled.mockResolvedValue(true);
    findUnique.mockResolvedValue({ timezone: "Europe/Berlin" });
  });

  it("returns null when the illness module is off (no read)", async () => {
    isIllnessEnabled.mockResolvedValue(false);
    const out = await buildIllnessScores("u1");
    expect(out).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("returns null when there is no episode to score", async () => {
    findFirst.mockResolvedValue(null);
    const out = await buildIllnessScores("u1");
    expect(out).toBeNull();
    expect(computeEpisodeCorrelation).not.toHaveBeenCalled();
  });

  it("prefers the active episode and surfaces the computed scores", async () => {
    // First findFirst call = active, second = resolved. Active wins.
    findFirst.mockResolvedValueOnce(ACTIVE).mockResolvedValueOnce(RESOLVED);
    computeEpisodeCorrelation.mockResolvedValue(okDerived());
    const out = await buildIllnessScores("u1");
    expect(out).not.toBeNull();
    // The active episode drove the read.
    expect(computeEpisodeCorrelation).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ id: "ep-active" }),
      "Europe/Berlin",
      expect.any(Date),
    );
    expect(out).toMatchObject({
      episodeLabel: "flu",
      state: "active",
      recoveryGapDays: 4,
      gapDriverType: "RESTING_HEART_RATE",
    });
    // Red flags carried verbatim.
    expect(out?.redFlags).toEqual([
      {
        type: "BODY_TEMPERATURE",
        reason: "sustained_fever",
        worstValue: 38.9,
        days: 3,
      },
    ]);
  });

  it("compacts nadir findings adverse-first and rounds the deviation", async () => {
    findFirst.mockResolvedValueOnce(ACTIVE).mockResolvedValueOnce(null);
    computeEpisodeCorrelation.mockResolvedValue(okDerived());
    const out = await buildIllnessScores("u1");
    // Adverse HRV finding leads the neutral WEIGHT one; deviation rounded to .1.
    expect(out?.nadir[0]).toEqual({
      type: "HEART_RATE_VARIABILITY",
      day: "2026-06-12",
      deviationSd: -2.4,
      direction: "below",
    });
  });

  it("falls back to the most-recently-resolved episode when none active", async () => {
    findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(RESOLVED);
    computeEpisodeCorrelation.mockResolvedValue({
      ...okDerived(),
      value: { ...okDerived().value, episodeId: "ep-resolved" },
    });
    const out = await buildIllnessScores("u1");
    expect(computeEpisodeCorrelation).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ id: "ep-resolved" }),
      "Europe/Berlin",
      expect.any(Date),
    );
    expect(out?.state).toBe("resolved");
  });

  it("returns null when the engine withholds (insufficient coverage)", async () => {
    findFirst.mockResolvedValueOnce(ACTIVE).mockResolvedValueOnce(null);
    computeEpisodeCorrelation.mockResolvedValue({ status: "insufficient" });
    const out = await buildIllnessScores("u1");
    expect(out).toBeNull();
  });
});
