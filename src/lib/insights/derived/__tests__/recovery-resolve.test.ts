import { describe, it, expect } from "vitest";
import {
  resolveCanonicalRecovery,
  type RecoveryRow,
} from "../recovery-resolve";

function row(iso: string, value: number, source: string): RecoveryRow {
  return { value, measuredAt: new Date(iso), source: source as never };
}

describe("resolveCanonicalRecovery", () => {
  it("prefers the WHOOP-native row over the COMPUTED proxy for the same day", () => {
    const rows = [
      row("2026-06-01T12:00:00Z", 50, "COMPUTED"),
      row("2026-06-01T06:00:00Z", 80, "WHOOP"),
    ];
    const resolved = resolveCanonicalRecovery(rows);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].source).toBe("WHOOP");
    expect(resolved[0].value).toBe(80);
  });

  it("falls back to COMPUTED when no WHOOP row exists for the day", () => {
    const rows = [row("2026-06-01T12:00:00Z", 55, "COMPUTED")];
    const resolved = resolveCanonicalRecovery(rows);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].source).toBe("COMPUTED");
    expect(resolved[0].value).toBe(55);
  });

  it("resolves per day — WHOOP one day, COMPUTED another", () => {
    const rows = [
      row("2026-06-02T12:00:00Z", 51, "COMPUTED"),
      row("2026-06-01T12:00:00Z", 49, "COMPUTED"),
      row("2026-06-01T06:00:00Z", 70, "WHOOP"),
    ];
    const resolved = resolveCanonicalRecovery(rows);
    // Sorted desc by measuredAt: 06-02 COMPUTED first, then 06-01 WHOOP.
    expect(resolved).toHaveLength(2);
    expect(resolved[0].source).toBe("COMPUTED");
    expect(resolved[0].value).toBe(51);
    expect(resolved[1].source).toBe("WHOOP");
    expect(resolved[1].value).toBe(70);
  });

  it("keeps the latest same-source row within a day", () => {
    const rows = [
      row("2026-06-01T06:00:00Z", 60, "WHOOP"),
      row("2026-06-01T18:00:00Z", 75, "WHOOP"),
    ];
    const resolved = resolveCanonicalRecovery(rows);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].value).toBe(75);
  });

  it("returns an empty list for no rows", () => {
    expect(resolveCanonicalRecovery([])).toEqual([]);
  });
});
