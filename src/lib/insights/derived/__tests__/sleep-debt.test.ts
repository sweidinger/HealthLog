import { describe, it, expect } from "vitest";
import {
  computeSleepDebt,
  type SleepDebtNight,
} from "../sleep-debt";

/** Build a contiguous run of nights ending YYYY-06-?? with given asleep mins. */
function nights(asleepPerNight: number[]): SleepDebtNight[] {
  return asleepPerNight.map((asleepMinutes, i) => ({
    night: `2026-06-${String(i + 1).padStart(2, "0")}`,
    asleepMinutes,
  }));
}

const NEED = 480; // 8 h need, pinned so the deficit math is exact.

describe("computeSleepDebt", () => {
  it("sums a deficit sequence into the exact cumulative debt", () => {
    // need 480; nights of 420 / 360 / 480 / 450 → deficits 60 / 120 / 0 / 30.
    const res = computeSleepDebt(nights([420, 360, 480, 450]), NEED, {
      minNights: 1,
    });
    expect(res.state).toBe("ready");
    expect(res.debtMinutes).toBe(60 + 120 + 0 + 30); // 210
    expect(res.perNight.map((n) => n.deficitMinutes)).toEqual([60, 120, 0, 30]);
    expect(res.nightsCounted).toBe(4);
    expect(res.needMinutes).toBe(NEED);
  });

  it("never mints negative deficit from catch-up sleep", () => {
    // A 10 h night (600) is 120 over need — deficit floors at 0, not −120.
    const res = computeSleepDebt(nights([600, 600]), NEED, { minNights: 1 });
    expect(res.debtMinutes).toBe(0);
    expect(res.perNight.every((n) => n.deficitMinutes === 0)).toBe(true);
  });

  it("caps a single catastrophic night's deficit", () => {
    // A 1 h night (60) is 420 short; the per-night cap (180) holds.
    const res = computeSleepDebt(nights([60]), NEED, {
      minNights: 1,
      maxNightlyDeficitMinutes: 180,
    });
    expect(res.perNight[0].deficitMinutes).toBe(180);
    expect(res.debtMinutes).toBe(180);
  });

  it("caps the cumulative total", () => {
    // Ten 0 h nights × 180 cap = 1800 raw, clamped to 1200 total cap.
    const res = computeSleepDebt(nights(Array(10).fill(0)), NEED, {
      minNights: 1,
      maxTotalDebtMinutes: 1200,
    });
    expect(res.debtMinutes).toBe(1200);
  });

  it("takes only the most recent windowNights and sorts oldest→newest", () => {
    // 16 nights of 420 (60 short each); window 14 → 14 × 60 = 840.
    const res = computeSleepDebt(nights(Array(16).fill(420)), NEED, {
      windowNights: 14,
    });
    expect(res.nightsCounted).toBe(14);
    expect(res.debtMinutes).toBe(14 * 60);
    expect(res.windowNights).toBe(14);
    // Oldest kept night is 2026-06-03 (06-01 and 06-02 aged out).
    expect(res.perNight[0].night).toBe("2026-06-03");
    expect(res.perNight.at(-1)?.night).toBe("2026-06-16");
  });

  it("debt drains as deficit nights age out of the rolling window", () => {
    // Two short nights then twelve full ones, window 14 → only the short
    // nights inside the window count; thirteen full + one short → drains.
    const fourteen = nights([360, ...Array(13).fill(480)]); // 1 short, 13 full
    const res = computeSleepDebt(fourteen, NEED, { windowNights: 14 });
    expect(res.debtMinutes).toBe(120); // only the 360 night carries debt
  });

  it("returns a calm partial state under the night threshold", () => {
    const res = computeSleepDebt(nights([300, 300, 300]), NEED, {
      minNights: 7,
    });
    expect(res.state).toBe("partial");
    expect(res.nightsCounted).toBe(3);
    expect(res.nightsUntilReady).toBe(4); // 7 − 3
    // It still reports the running figure so the UI can show a soft preview.
    expect(res.debtMinutes).toBe(3 * 180); // each night 180 short
  });

  it("clears the partial state at or above the threshold", () => {
    const res = computeSleepDebt(nights(Array(7).fill(420)), NEED, {
      minNights: 7,
    });
    expect(res.state).toBe("ready");
    expect(res.nightsUntilReady).toBe(0);
  });

  it("guards a non-positive need (no fabricated debt)", () => {
    const res = computeSleepDebt(nights([300, 300]), 0, { minNights: 1 });
    expect(res.state).toBe("partial");
    expect(res.debtMinutes).toBe(0);
    expect(res.needMinutes).toBe(0);
  });
});
