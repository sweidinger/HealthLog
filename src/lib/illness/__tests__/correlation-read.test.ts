/**
 * v1.18.1 P3 — illness correlation READ layer + rollup-vs-live parity.
 *
 * The reliability anchor: the same per-day series fed to the engine must
 * produce IDENTICAL findings whether it was resolved from the rollup DAY tier
 * or the live-SQL fallback. We drive `computeEpisodeCorrelation` twice over the
 * SAME underlying daily data — once with full rollup coverage (the DAY path),
 * once with a coverage miss (the live raw-read path) — and assert the engine
 * output is byte-identical (modulo the provenance `source` tag).
 *
 * Also pins the contamination-guard READ window: the baseline read window must
 * end strictly before the pre-onset lookback (no episode-span day reaches the
 * baseline query).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* The DAY-native daily means the test universe holds for RESTING_HEART_RATE.
 * Baseline window sits at ~55; the episode-span (from 01-03 onward) spikes.
 * Onset 2026-01-10, lookback 7 → pre-onset starts 2026-01-03; baseline window
 * is the 30 days ending 2026-01-03. */
const DAILY: Array<{ day: string; mean: number }> = [];
{
  // 30 clean baseline days ending the day before 2026-01-03.
  let cursor = Date.parse("2026-01-02T00:00:00Z");
  // Even spread around 55 so the MAD (and band) is non-zero and stable.
  const offsets = [-2, -1, 0, 1, 2];
  for (let i = 0; i < 30; i++) {
    DAILY.unshift({
      day: new Date(cursor).toISOString().slice(0, 10),
      mean: 55 + offsets[i % offsets.length],
    });
    cursor -= 24 * 60 * 60 * 1000;
  }
  // Episode span.
  for (const [day, mean] of [
    ["2026-01-03", 56],
    ["2026-01-08", 70], // pre-onset notable
    ["2026-01-10", 74],
    ["2026-01-12", 76], // nadir
    ["2026-01-15", 64],
    ["2026-01-17", 58],
    ["2026-01-18", 55],
    ["2026-01-19", 55],
    ["2026-01-20", 55],
  ] as const) {
    DAILY.push({ day, mean });
  }
}

const NOW = new Date("2026-01-21T12:00:00Z");

const db = vi.hoisted(() => ({
  measurement: { findMany: vi.fn() },
}));
const rollup = vi.hoisted(() => ({
  probeRollupCoverage: vi.fn(),
  readBestGranularityRollups: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/rollups/measurement-coverage", () => ({
  probeRollupCoverage: rollup.probeRollupCoverage,
}));
vi.mock("@/lib/rollups/measurement-read-wmy", () => ({
  readBestGranularityRollups: rollup.readBestGranularityRollups,
}));

import { computeEpisodeCorrelation } from "../correlation-read";
import { ILLNESS_SCAN_TYPES } from "../correlation";

/**
 * An ACTIVE episode (no resolvedAt) so the episode-window read's `to` is
 * effectively `now` — this exercises the trailing rollup DAY path in the
 * covered case and the trailing live path in the miss case, the exact seam
 * the parity test must pin. The baseline window stays bounded (raw both ways).
 */
const EPISODE = {
  id: "ep-parity",
  onsetAt: new Date("2026-01-10T08:00:00Z"),
  resolvedAt: null as Date | null,
  lifecycle: "ACUTE",
};

/** Daily rows within [from, to) as a raw-measurement findMany result. */
function rawRowsWithin(from: Date, to: Date) {
  const fromKey = from.toISOString().slice(0, 10);
  const toKey = to.toISOString().slice(0, 10);
  return DAILY.filter((d) => d.day >= fromKey && d.day < toKey).map((d) => ({
    value: d.mean,
    measuredAt: new Date(`${d.day}T12:00:00Z`),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("computeEpisodeCorrelation — rollup-vs-live parity", () => {
  function onlyRhr<T>(map: Map<string, T>): Map<string, T> {
    return map;
  }

  it("produces identical findings on the DAY path and the live path", async () => {
    // ── DAY path: full coverage for RESTING_HEART_RATE, rollup serves the
    //    trailing (to == now) episode-window read; the bounded baseline read
    //    goes through measurement.findMany (to != now). ──
    const dayCoverage = onlyRhr(
      new Map<string, boolean>(ILLNESS_SCAN_TYPES.map((t) => [String(t), t === "RESTING_HEART_RATE"])),
    );
    rollup.probeRollupCoverage.mockResolvedValue(dayCoverage);
    rollup.readBestGranularityRollups.mockImplementation(
      async (_u: string, type: string, windowDays: number) => {
        if (type !== "RESTING_HEART_RATE") return null;
        const since = new Date(NOW.getTime() - windowDays * 24 * 60 * 60 * 1000);
        const sinceKey = since.toISOString().slice(0, 10);
        const rows = DAILY.filter((d) => d.day >= sinceKey).map((d) => ({
          bucketStart: new Date(`${d.day}T00:00:00Z`),
          count: 1,
          mean: d.mean,
          sd: null,
          slope: null,
          r2: null,
          sumValue: null,
          minValue: d.mean,
          maxValue: d.mean,
        }));
        return rows.length > 0 ? { granularity: "DAY" as const, rows } : null;
      },
    );
    db.measurement.findMany.mockImplementation(async ({ where }: { where: { type: string; measuredAt: { gte: Date; lt: Date } } }) => {
      if (where.type !== "RESTING_HEART_RATE") return [];
      return rawRowsWithin(where.measuredAt.gte, where.measuredAt.lt);
    });

    const dayOut = await computeEpisodeCorrelation("u1", EPISODE, "UTC", NOW);

    // ── Live path: zero rollup coverage, every read falls to findMany. The
    //    baseline engine's live fallback groups raw rows itself for the
    //    trailing read; we serve the same DAILY universe for any window. ──
    vi.clearAllMocks();
    const noCoverage = new Map<string, boolean>(
      ILLNESS_SCAN_TYPES.map((t) => [String(t), false]),
    );
    rollup.probeRollupCoverage.mockResolvedValue(noCoverage);
    rollup.readBestGranularityRollups.mockResolvedValue(null);
    db.measurement.findMany.mockImplementation(
      async ({ where }: { where: { type: string; measuredAt: { gte: Date; lt?: Date } } }) => {
        if (where.type !== "RESTING_HEART_RATE") return [];
        const from = where.measuredAt.gte;
        const to = where.measuredAt.lt ?? NOW;
        return rawRowsWithin(from, to);
      },
    );

    const liveOut = await computeEpisodeCorrelation("u1", EPISODE, "UTC", NOW);

    expect(dayOut.status).toBe("ok");
    expect(liveOut.status).toBe("ok");
    if (dayOut.status !== "ok" || liveOut.status !== "ok") return;

    // Same numbers regardless of read path (the parity guarantee): the
    // DAY-rollup-fed series and the live-SQL series produce byte-identical
    // findings.
    expect(liveOut.value.recoveryGapDays).toBe(dayOut.value.recoveryGapDays);
    expect(liveOut.value.nadir).toEqual(dayOut.value.nadir);
    expect(liveOut.value.preOnset).toEqual(dayOut.value.preOnset);
    expect(liveOut.value.returns).toEqual(dayOut.value.returns);

    // And the findings are the expected golden values.
    expect(dayOut.value.nadir[0]?.day).toBe("2026-01-12");
    expect(dayOut.value.nadir[0]?.value).toBe(76);
    expect(dayOut.value.preOnset[0]?.day).toBe("2026-01-08");
    // Active episode → no felt-better marker → the gap is null but the
    // physiological return is still detected (01-17 is the first in-band day
    // that then holds for ≥3 observed days).
    expect(dayOut.value.recoveryGapDays).toBeNull();
    expect(dayOut.value.returns[0]?.returnedDay).toBe("2026-01-17");
  });
});

describe("computeEpisodeCorrelation — contamination-guard read window", () => {
  it("never queries baseline rows on or after the pre-onset lookback start", async () => {
    rollup.probeRollupCoverage.mockResolvedValue(
      new Map<string, boolean>(ILLNESS_SCAN_TYPES.map((t) => [String(t), false])),
    );
    rollup.readBestGranularityRollups.mockResolvedValue(null);
    const seen: Array<{ gte: Date; lt?: Date }> = [];
    db.measurement.findMany.mockImplementation(
      async ({ where }: { where: { type: string; measuredAt: { gte: Date; lt?: Date } } }) => {
        if (where.type === "RESTING_HEART_RATE") seen.push(where.measuredAt);
        return [];
      },
    );

    await computeEpisodeCorrelation("u1", EPISODE, "UTC", NOW);

    // The pre-onset lookback starts at onset − 7 days = 2026-01-03.
    const lookbackStart = Date.parse("2026-01-03T08:00:00Z");
    // The bounded baseline read (the one with a `lt`) must END at/ before
    // the lookback start — no baseline query may reach into the episode span.
    const boundedBaseline = seen.filter((w) => w.lt !== undefined);
    expect(boundedBaseline.length).toBeGreaterThan(0);
    for (const w of boundedBaseline) {
      expect(w.lt!.getTime()).toBeLessThanOrEqual(lookbackStart);
    }
  });
});
