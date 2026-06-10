/**
 * v1.15.19 — `updateIntakeEventSchema.takenAt` plausibility bounds
 * (audit P0-4).
 *
 * A date typo on an intake edit could previously park `takenAt` on any
 * instant — a month before the slot, a year in the future — with no
 * pushback. The schema now rejects a future `takenAt` (beyond a small
 * clock-skew allowance) and anything older than 5 years; the
 * per-medication start-date floor lives in the route, the slot-distance
 * hint in the edit dialog.
 */
import { describe, expect, it } from "vitest";

import { updateIntakeEventSchema } from "@/lib/validations/medication";

const HOUR_MS = 60 * 60 * 1000;
const YEAR_MS = 365 * 24 * HOUR_MS;

describe("updateIntakeEventSchema — takenAt bounds (P0-4)", () => {
  it("accepts a takenAt in the recent past", () => {
    const result = updateIntakeEventSchema.safeParse({
      takenAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.takenAt).toBeInstanceOf(Date);
    }
  });

  it("accepts a takenAt slightly ahead of now (clock skew)", () => {
    const result = updateIntakeEventSchema.safeParse({
      takenAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a takenAt in the future beyond the skew allowance", () => {
    const result = updateIntakeEventSchema.safeParse({
      takenAt: new Date(Date.now() + HOUR_MS).toISOString(),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("future");
    }
  });

  it("rejects a takenAt more than 5 years in the past", () => {
    const result = updateIntakeEventSchema.safeParse({
      takenAt: new Date(Date.now() - 6 * YEAR_MS).toISOString(),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("5 years");
    }
  });

  it("accepts a takenAt within the 5-year window", () => {
    const result = updateIntakeEventSchema.safeParse({
      takenAt: new Date(Date.now() - 4 * YEAR_MS).toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("still accepts an explicit null takenAt (clears the take)", () => {
    const result = updateIntakeEventSchema.safeParse({
      takenAt: null,
      skipped: true,
    });
    expect(result.success).toBe(true);
  });

  it("still accepts a body that omits takenAt entirely", () => {
    const result = updateIntakeEventSchema.safeParse({ skipped: false });
    expect(result.success).toBe(true);
  });
});
