import { describe, it, expect } from "vitest";
import { berlinDayKey } from "../berlin-day";

/**
 * v1.4.22 W5 reconcile (Code-MED-3) — pin that the helper buckets a
 * 23:30-Berlin reading on Tuesday into the Tuesday key, regardless of
 * UTC offset (CET / CEST, DST).
 */
describe("berlinDayKey", () => {
  it("buckets a 23:30-Berlin reading on Tuesday into Tuesday's key (CEST)", () => {
    // 2025-10-25T21:30:00Z = 2025-10-25T23:30 CEST (Saturday before DST end)
    expect(berlinDayKey(new Date("2025-10-25T21:30:00Z"))).toBe("2025-10-25");
  });

  it("buckets a 23:30-Berlin reading after DST end into the right Berlin day", () => {
    // 2025-10-26 is the DST end day in Europe/Berlin (CET takes over).
    // 2025-10-26T22:30:00Z = 2025-10-26T23:30 CET — still Sunday in Berlin.
    expect(berlinDayKey(new Date("2025-10-26T22:30:00Z"))).toBe("2025-10-26");
  });

  it("crosses the UTC-midnight boundary in Berlin's favour", () => {
    // 2026-05-09T22:30:00Z falls on 2026-05-10T00:30 CEST — Berlin says
    // Sunday, UTC says Saturday. The helper must follow Berlin.
    expect(berlinDayKey(new Date("2026-05-09T22:30:00Z"))).toBe("2026-05-10");
  });

  it("returns YYYY-MM-DD format (sortable, padded)", () => {
    expect(berlinDayKey(new Date("2026-01-09T12:00:00Z"))).toBe("2026-01-09");
    expect(berlinDayKey(new Date("2026-12-09T12:00:00Z"))).toBe("2026-12-09");
  });
});
