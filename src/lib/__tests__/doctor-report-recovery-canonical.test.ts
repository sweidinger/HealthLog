import { describe, it, expect } from "vitest";
import { summariseCanonicalRecovery } from "@/lib/doctor-report-data";

function m(type: string, value: number, iso: string, source: string) {
  return { type, value, measuredAt: new Date(iso), source: source as never };
}

describe("summariseCanonicalRecovery", () => {
  it("returns null when no recovery rows exist", () => {
    expect(
      summariseCanonicalRecovery([
        m("STRESS_SCORE", 40, "2026-06-01T12:00:00Z", "COMPUTED"),
      ]),
    ).toBeNull();
  });

  it("prefers the WHOOP-native row over the COMPUTED proxy per night", () => {
    // ONE physiological night (wake morning Jun 1) carries both rows on their
    // real, off-by-one stamps: WHOOP stamps the wake morning (Jun 1), the
    // COMPUTED proxy stamps the day that ended (May 31 noon). The resolver
    // shifts the proxy onto the wake day so they collapse to one night, and the
    // PDF reads the native value, not a blend.
    const summary = summariseCanonicalRecovery([
      m("RECOVERY_SCORE", 50, "2026-05-31T12:00:00Z", "COMPUTED"),
      m("RECOVERY_SCORE", 80, "2026-06-01T06:00:00Z", "WHOOP"),
    ]);
    expect(summary).not.toBeNull();
    // Only the canonical (WHOOP) row counts — avg/min/max/latest all 80, not 65.
    expect(summary!.latest).toBe(80);
    expect(summary!.avg).toBe(80);
    expect(summary!.min).toBe(80);
    expect(summary!.max).toBe(80);
    expect(summary!.count).toBe(1);
  });

  it("summarises across nights using one canonical row each", () => {
    // Night A (wake Jun 1): WHOOP 80 + its COMPUTED proxy 40 (stamped May 31
    // noon) collapse to the native 80. Night B (wake Jun 2): a COMPUTED-only
    // proxy 60, stamped Jun 1 noon, stands alone.
    const summary = summariseCanonicalRecovery([
      m("RECOVERY_SCORE", 60, "2026-06-01T12:00:00Z", "COMPUTED"),
      m("RECOVERY_SCORE", 80, "2026-06-01T06:00:00Z", "WHOOP"),
      m("RECOVERY_SCORE", 40, "2026-05-31T12:00:00Z", "COMPUTED"),
    ]);
    expect(summary!.count).toBe(2);
    // Canonical set: night B COMPUTED 60 (latest stamp), night A WHOOP 80
    // (proxy 40 dropped).
    expect(summary!.latest).toBe(60);
    expect(summary!.min).toBe(60);
    expect(summary!.max).toBe(80);
    expect(summary!.avg).toBe(70);
  });
});
