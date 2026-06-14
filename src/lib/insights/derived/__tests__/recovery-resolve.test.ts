import { describe, it, expect } from "vitest";
import {
  resolveCanonicalRecovery,
  type RecoveryRow,
} from "../recovery-resolve";

function row(iso: string, value: number, source: string): RecoveryRow {
  return { value, measuredAt: new Date(iso), source: source as never };
}

// All stamps below use REALISTIC source clocks for one physiological night:
//   - WHOOP    stamps the wake-morning instant (`updated_at`).
//   - COMPUTED stamps noon-UTC of the day-that-ended (`scoreDayKey = run − 1d`),
//     so for the SAME night it lands one calendar day BEFORE the WHOOP row.
// Europe/Berlin (the resolver default) is UTC+2 in June, so a noon-UTC stamp
// reads as the same local day and a ~06:00-UTC wake stamp reads as the wake day.
describe("resolveCanonicalRecovery", () => {
  it("collapses the same night's WHOOP + COMPUTED rows to the WHOOP value", () => {
    // Night of Jun 01 → wake Jun 02. WHOOP scores Jun 02 morning; the COMPUTED
    // proxy for that readiness is filed under Jun 01 (the day that ended). With
    // realistic stamps the two land on DIFFERENT calendar days — the resolver's
    // source-aware wake-day key must still fold them into ONE canonical night.
    const rows = [
      row("2026-06-01T12:00:00Z", 50, "COMPUTED"), // day-that-ended stamp
      row("2026-06-02T06:00:00Z", 80, "WHOOP"), // wake-morning stamp
    ];
    const resolved = resolveCanonicalRecovery(rows);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].source).toBe("WHOOP");
    expect(resolved[0].value).toBe(80);
  });

  it("falls back to COMPUTED when no WHOOP row exists for the night", () => {
    const rows = [row("2026-06-01T12:00:00Z", 55, "COMPUTED")];
    const resolved = resolveCanonicalRecovery(rows);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].source).toBe("COMPUTED");
    expect(resolved[0].value).toBe(55);
  });

  it("keeps a genuinely SEPARATE next night separate", () => {
    // Two nights: Jun 01→02 (WHOOP, wake Jun 02) and Jun 02→03 (COMPUTED proxy
    // filed under Jun 02). Despite both touching the Jun 02 calendar day on raw
    // stamps, they are DIFFERENT nights and must stay two canonical rows.
    const rows = [
      row("2026-06-02T12:00:00Z", 51, "COMPUTED"), // night Jun02→03, wake Jun03
      row("2026-06-02T06:00:00Z", 70, "WHOOP"), // night Jun01→02, wake Jun02
    ];
    const resolved = resolveCanonicalRecovery(rows);
    expect(resolved).toHaveLength(2);
    // Sorted desc by measuredAt: the Jun02-noon COMPUTED first, then the
    // Jun02-06:00 WHOOP. Both survive — no night was merged away.
    expect(resolved.map((r) => r.value).sort()).toEqual([51, 70]);
    expect(resolved.map((r) => r.source).sort()).toEqual(["COMPUTED", "WHOOP"]);
  });

  it("keeps the latest same-source row within a night", () => {
    const rows = [
      row("2026-06-02T06:00:00Z", 60, "WHOOP"),
      row("2026-06-02T08:00:00Z", 75, "WHOOP"), // a morning re-score
    ];
    const resolved = resolveCanonicalRecovery(rows);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].value).toBe(75);
  });

  it("buckets by the user's local wake-day, not UTC", () => {
    // A WHOOP wake stamp just after local midnight in a far-east zone. Read in
    // UTC it would file under the previous calendar day; in the user's zone it
    // is the wake day, matching the COMPUTED proxy's forward-shifted anchor.
    const rows = [
      // Pacific/Auckland (UTC+12 in June): 2026-06-02T13:00:00Z = 2026-06-03 01:00 local.
      row("2026-06-02T13:00:00Z", 82, "WHOOP"),
      // COMPUTED proxy for the same wake (Jun 03 local): filed Jun 02 noon UTC,
      // which is Jun 03 00:00 local → shifted forward to Jun 03 local wake day.
      row("2026-06-02T00:00:00Z", 40, "COMPUTED"),
    ];
    const resolved = resolveCanonicalRecovery(rows, "Pacific/Auckland");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].source).toBe("WHOOP");
    expect(resolved[0].value).toBe(82);
  });

  it("returns an empty list for no rows", () => {
    expect(resolveCanonicalRecovery([])).toEqual([]);
  });
});
