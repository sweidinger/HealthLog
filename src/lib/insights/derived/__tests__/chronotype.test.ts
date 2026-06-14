import { describe, it, expect } from "vitest";
import {
  computeChronotype,
  bandForMSFsc,
  type ChronotypeNight,
} from "../chronotype";

/** Minutes-of-day for HH:MM. */
function hm(h: number, m = 0): number {
  return h * 60 + m;
}

function freeNight(
  day: number,
  midpointMinutes: number,
  asleepMinutes: number,
): ChronotypeNight {
  return {
    night: `2026-06-${String(day).padStart(2, "0")}`,
    midpointMinutes,
    asleepMinutes,
    dayType: "free",
  };
}

function workNight(
  day: number,
  midpointMinutes: number,
  asleepMinutes: number,
): ChronotypeNight {
  return {
    night: `2026-06-${String(day).padStart(2, "0")}`,
    midpointMinutes,
    asleepMinutes,
    dayType: "work",
  };
}

describe("bandForMSFsc", () => {
  it("bands MSFsc minutes-of-day into MCTQ classes", () => {
    expect(bandForMSFsc(hm(2, 0))).toBe("extreme_early"); // 02:00
    expect(bandForMSFsc(hm(3, 0))).toBe("early"); // 03:00
    expect(bandForMSFsc(hm(4, 0))).toBe("intermediate"); // 04:00
    expect(bandForMSFsc(hm(5, 30))).toBe("late"); // 05:30
    expect(bandForMSFsc(hm(7, 0))).toBe("extreme_late"); // 07:00
  });

  it("normalises a midnight-straddling / corrected value onto the clock", () => {
    expect(bandForMSFsc(hm(24, 0) + hm(1, 0))).toBe("extreme_early"); // 25:00→01:00
    expect(bandForMSFsc(-30)).toBe("extreme_late"); // −0:30 → 23:30
  });
});

describe("computeChronotype", () => {
  it("computes MSF + band from a free-day mid-sleep set (no debt correction)", () => {
    // Three free nights all centred at 04:00, equal-length → SDf == SDweek →
    // MSFsc == MSF == 240 → intermediate.
    const res = computeChronotype([
      freeNight(1, hm(4), 480),
      freeNight(2, hm(4), 480),
      freeNight(3, hm(4), 480),
    ]);
    expect(res.state).toBe("ready");
    expect(res.msfMinutes).toBeCloseTo(240, 6);
    expect(res.msfScMinutes).toBeCloseTo(240, 6);
    expect(res.band).toBe("intermediate");
  });

  it("applies the MSFsc sleep-debt correction when free days oversleep", () => {
    // 3 free nights @ 04:00 / 9 h (540) + 3 work nights @ 03:00 / 6 h (360).
    // SDf = 540; SDweek = (540·3 + 360·3)/6 = 450; oversleep = 90.
    // MSFsc = 240 − 0.5·90 = 195 → "early" (< 03:30).
    const res = computeChronotype([
      freeNight(1, hm(4), 540),
      freeNight(2, hm(4), 540),
      freeNight(3, hm(4), 540),
      workNight(4, hm(3), 360),
      workNight(5, hm(3), 360),
      workNight(6, hm(3), 360),
    ]);
    expect(res.msfMinutes).toBeCloseTo(240, 6);
    expect(res.msfScMinutes).toBeCloseTo(195, 6);
    expect(res.band).toBe("early"); // 195 → early (< 03:30)
  });

  it("computes social jetlag as circular |MSF_work − MSF_free|", () => {
    // Free mid-sleep 04:00 (240), work mid-sleep 03:00 (180) → SJL = 60.
    const res = computeChronotype([
      freeNight(1, hm(4), 480),
      freeNight(2, hm(4), 480),
      freeNight(3, hm(4), 480),
      workNight(4, hm(3), 480),
      workNight(5, hm(3), 480),
    ]);
    expect(res.socialJetlagMinutes).toBeCloseTo(60, 6);
    expect(res.workNightsCounted).toBe(2);
    expect(res.freeNightsCounted).toBe(3);
  });

  it("measures social jetlag across midnight by the shorter arc", () => {
    // Work mid-sleep 23:30 (1410), free mid-sleep 00:30 (30) → circular 60,
    // not 1380 — the midnight-straddle handling from circularMinuteDistance.
    const res = computeChronotype([
      freeNight(1, hm(0, 30), 480),
      freeNight(2, hm(0, 30), 480),
      freeNight(3, hm(0, 30), 480),
      workNight(4, hm(23, 30), 480),
    ]);
    expect(res.socialJetlagMinutes).toBeCloseTo(60, 6);
  });

  it("fires the learning gate under the free-night threshold", () => {
    const res = computeChronotype(
      [freeNight(1, hm(4), 480), freeNight(2, hm(4), 480)],
      { minFreeNights: 3 },
    );
    expect(res.state).toBe("learning");
    expect(res.band).toBeNull();
    expect(res.msfMinutes).toBeNull();
    expect(res.msfScMinutes).toBeNull();
    expect(res.freeNightsCounted).toBe(2);
    expect(res.freeNightsUntilReady).toBe(1); // 3 − 2
  });

  it("clears the learning gate at the threshold", () => {
    const res = computeChronotype(
      [
        freeNight(1, hm(4), 480),
        freeNight(2, hm(4), 480),
        freeNight(3, hm(4), 480),
      ],
      { minFreeNights: 3 },
    );
    expect(res.state).toBe("ready");
    expect(res.band).not.toBeNull();
  });

  it("work-only data stays learning and reports no social jetlag", () => {
    const res = computeChronotype([
      workNight(1, hm(3), 480),
      workNight(2, hm(3), 480),
      workNight(3, hm(3), 480),
    ]);
    expect(res.state).toBe("learning");
    expect(res.socialJetlagMinutes).toBeNull(); // no free side to compare
    expect(res.freeNightsCounted).toBe(0);
  });

  it("ignores nights with zero asleep minutes", () => {
    const res = computeChronotype([
      freeNight(1, hm(4), 480),
      freeNight(2, hm(4), 0), // dropped
      freeNight(3, hm(4), 480),
    ]);
    expect(res.freeNightsCounted).toBe(2);
    expect(res.state).toBe("learning");
  });
});
