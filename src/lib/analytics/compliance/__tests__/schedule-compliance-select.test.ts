/**
 * v1.15.20 — pins the shared schedule select for compliance call sites.
 *
 * Every surface that loads schedules for a compliance computation routes
 * through `SCHEDULE_COMPLIANCE_SELECT`. The constant must keep selecting
 * every field the engine consumes — most importantly `doseWindows`, whose
 * absence silently degrades a user-configured on-time band back to the
 * symmetric default on that surface (the v1.15.20 audit gap: only 2 of 8
 * call sites selected it).
 */
import { describe, expect, it } from "vitest";

import { SCHEDULE_COMPLIANCE_SELECT } from "@/lib/analytics/compliance";

describe("SCHEDULE_COMPLIANCE_SELECT", () => {
  it("selects every schedule field the compliance engine consumes", () => {
    expect(SCHEDULE_COMPLIANCE_SELECT).toEqual({
      id: true,
      windowStart: true,
      windowEnd: true,
      daysOfWeek: true,
      timesOfDay: true,
      reminderGraceMinutes: true,
      rrule: true,
      rollingIntervalDays: true,
      scheduleType: true,
      cyclicOnWeeks: true,
      cyclicOffWeeks: true,
      doseWindows: true,
    });
  });

  it("keeps the configured per-dose windows on the wire", () => {
    // The one field whose loss is silent: the engine falls back to the
    // ±1 h default and every number still "looks" right.
    expect(SCHEDULE_COMPLIANCE_SELECT.doseWindows).toBe(true);
  });
});
