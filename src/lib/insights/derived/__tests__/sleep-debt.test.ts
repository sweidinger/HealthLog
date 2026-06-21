import { describe, it, expect } from "vitest";
import { computeSleepDebt, type SleepDebtNight } from "../sleep-debt";

/** Build a contiguous run of nights ending YYYY-06-?? with given asleep mins. */
function nights(asleepPerNight: number[]): SleepDebtNight[] {
  return asleepPerNight.map((asleepMinutes, i) => ({
    night: `2026-06-${String(i + 1).padStart(2, "0")}`,
    asleepMinutes,
  }));
}

const NEED = 480; // 8 h need, pinned so the deficit math is exact.

describe("computeSleepDebt — rolling balance", () => {
  it("a well-rested week reads near-zero debt", () => {
    // Seven nights at need exactly → no deficit ever accrues.
    const res = computeSleepDebt(nights(Array(7).fill(480)), NEED, {
      minNights: 4,
    });
    expect(res.state).toBe("ready");
    expect(res.debtMinutes).toBe(0);
  });

  it("keeps a modestly-short week bounded by the short window, not a fortnight sum", () => {
    // The v1.17.0 bug: ~30 min short every night summed over 14 nights to ~7 h
    // of standing debt. The balance model with a 5-night window keeps it small:
    // five nights ~30 min short (450) → 5 × 30 = 150 min, never the old 7 h.
    const res = computeSleepDebt(nights(Array(7).fill(450)), NEED, {
      minNights: 4,
    });
    expect(res.debtMinutes).toBe(5 * 30);
    expect(res.windowNights).toBe(5);
  });

  it("surplus nights pay the running balance down (recovery)", () => {
    // Short night (360 = 120 short) then a long catch-up night (600 = 120 over).
    // Deficit adds 120; surplus pays down 0.5 × 120 = 60 → balance 60.
    const res = computeSleepDebt(nights([360, 600]), NEED, { minNights: 1 });
    expect(res.perNight.map((n) => n.deltaMinutes)).toEqual([120, -60]);
    expect(res.debtMinutes).toBe(60);
  });

  it("a single short night carries only that night's deficit, bounded", () => {
    // Four full nights then one 6 h night (360 = 120 short) → balance 120.
    const res = computeSleepDebt(nights([480, 480, 480, 480, 360]), NEED, {
      minNights: 1,
    });
    expect(res.debtMinutes).toBe(120);
  });

  it("recovers to zero after enough catch-up sleep", () => {
    // Two short nights (each 120 short = +240 balance) then long catch-up nights
    // (each 240 over → pays 0.5 × 240 = 120 down). Two catch-up nights clear it.
    const res = computeSleepDebt([...nights([360, 360, 720, 720, 480])], NEED, {
      minNights: 1,
      maxNightlyDeficitMinutes: 180,
    });
    expect(res.debtMinutes).toBe(0);
  });

  it("never mints negative debt — surplus alone floors at zero", () => {
    const res = computeSleepDebt(nights([600, 600]), NEED, { minNights: 1 });
    expect(res.debtMinutes).toBe(0);
  });

  it("caps a single catastrophic night's deficit", () => {
    // A 1 h night (60) is 420 short; the per-night cap (180) holds.
    const res = computeSleepDebt(nights([60]), NEED, {
      minNights: 1,
      maxNightlyDeficitMinutes: 180,
    });
    expect(res.perNight[0].deltaMinutes).toBe(180);
    expect(res.debtMinutes).toBe(180);
  });

  it("caps the running balance total", () => {
    // Five 0 h nights × 180 cap = 900 raw, clamped to a 600 balance cap.
    const res = computeSleepDebt(nights(Array(5).fill(0)), NEED, {
      minNights: 1,
      maxTotalDebtMinutes: 600,
    });
    expect(res.debtMinutes).toBe(600);
  });

  it("takes only the most recent windowNights and sorts oldest→newest", () => {
    // 8 nights of 420 (60 short each); window 5 → balance walks 5 × 60 = 300.
    const res = computeSleepDebt(nights(Array(8).fill(420)), NEED, {
      windowNights: 5,
    });
    expect(res.nightsCounted).toBe(5);
    expect(res.debtMinutes).toBe(5 * 60);
    expect(res.windowNights).toBe(5);
    // Oldest kept night is 2026-06-04 (06-01..06-03 aged out of the 5-window).
    expect(res.perNight[0].night).toBe("2026-06-04");
    expect(res.perNight.at(-1)?.night).toBe("2026-06-08");
  });

  it("debt drains as deficit nights age out of the rolling window", () => {
    // One short night then five full ones, window 5 → the short night ages out
    // entirely, leaving only full nights inside the window → zero balance.
    const res = computeSleepDebt(nights([360, 480, 480, 480, 480, 480]), NEED, {
      windowNights: 5,
    });
    expect(res.debtMinutes).toBe(0);
  });

  it("returns a calm partial state under the night threshold", () => {
    const res = computeSleepDebt(nights([300, 300, 300]), NEED, {
      minNights: 4,
    });
    expect(res.state).toBe("partial");
    expect(res.nightsCounted).toBe(3);
    expect(res.nightsUntilReady).toBe(1); // 4 − 3
    // It still reports the running balance so the UI can show a soft preview.
    expect(res.debtMinutes).toBe(3 * 180); // each night 180 short, no surplus
  });

  it("clears the partial state at or above the threshold", () => {
    const res = computeSleepDebt(nights(Array(4).fill(420)), NEED, {
      minNights: 4,
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

  it("reports minutes (unit correctness) — a 90-min standing deficit is 90, not 1.5", () => {
    // One 90-min-short night inside an otherwise-met window.
    const res = computeSleepDebt(nights([480, 480, 480, 480, 390]), NEED, {
      minNights: 1,
    });
    expect(res.debtMinutes).toBe(90);
  });
});
