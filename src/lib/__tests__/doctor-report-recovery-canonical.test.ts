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

  it("prefers the WHOOP-native row over the COMPUTED proxy per day", () => {
    // The same day has a low proxy AND a high native row. The PDF must read the
    // native value, not blend both into one average.
    const summary = summariseCanonicalRecovery([
      m("RECOVERY_SCORE", 50, "2026-06-01T12:00:00Z", "COMPUTED"),
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

  it("summarises across days using one canonical row each", () => {
    const summary = summariseCanonicalRecovery([
      m("RECOVERY_SCORE", 60, "2026-06-02T12:00:00Z", "COMPUTED"),
      m("RECOVERY_SCORE", 80, "2026-06-01T06:00:00Z", "WHOOP"),
      m("RECOVERY_SCORE", 40, "2026-06-01T12:00:00Z", "COMPUTED"),
    ]);
    expect(summary!.count).toBe(2);
    // Canonical set: 06-02 COMPUTED 60, 06-01 WHOOP 80 (proxy 40 dropped).
    expect(summary!.latest).toBe(60);
    expect(summary!.min).toBe(60);
    expect(summary!.max).toBe(80);
    expect(summary!.avg).toBe(70);
  });
});
