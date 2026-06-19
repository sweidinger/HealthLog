/**
 * v1.16.10 — shared supply-summary math (`summariseSupply`).
 *
 * Pins the release-QA disagreement scenario: a single EXPIRED pen with
 * units left must read as ZERO available supply on every surface
 * (Übersicht supply row, Bestand summary, list payload, GLP-1 endpoint)
 * while the expired units stay visible separately. Both detail-page
 * surfaces render from this helper, so the predicate cannot drift from
 * the list / GLP-1 one (ACTIVE / IN_USE with units only).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  isAvailableSupply,
  summariseSupply,
} from "@/lib/medications/inventory/summary";

describe("summariseSupply — expired stock is visible but never available", () => {
  it("one expired pen with units ⇒ 0 available, expired units surfaced separately", () => {
    const out = summariseSupply(
      [{ state: "EXPIRED", unitsTotal: 4, unitsRemaining: 4 }],
      1,
    );
    expect(out).toEqual({
      unitsRemaining: 0,
      unitsTotal: 0,
      dosesRemaining: 0,
      dosesTotal: 0,
      expiredUnits: 4,
    });
  });

  it("pools only ACTIVE / IN_USE containers with units left", () => {
    const out = summariseSupply(
      [
        { state: "IN_USE", unitsTotal: 4, unitsRemaining: 3 },
        { state: "ACTIVE", unitsTotal: 4, unitsRemaining: 4 },
        { state: "USED_UP", unitsTotal: 4, unitsRemaining: 0 },
        { state: "EXPIRED", unitsTotal: 4, unitsRemaining: 4 },
      ],
      2,
    );
    // 7 available units / 2 per dose = 3 doses; capacity 8 units = 4 doses.
    expect(out).toEqual({
      unitsRemaining: 7,
      unitsTotal: 8,
      dosesRemaining: 3,
      dosesTotal: 4,
      expiredUnits: 4,
    });
  });

  it("a drained (used-up) container counts nowhere", () => {
    const out = summariseSupply(
      [{ state: "USED_UP", unitsTotal: 4, unitsRemaining: 0 }],
      1,
    );
    expect(out).toEqual({
      unitsRemaining: 0,
      unitsTotal: 0,
      dosesRemaining: 0,
      dosesTotal: 0,
      expiredUnits: 0,
    });
  });

  it("matches the list-route availability predicate per state", () => {
    expect(
      isAvailableSupply({ state: "ACTIVE", unitsTotal: 4, unitsRemaining: 4 }),
    ).toBe(true);
    expect(
      isAvailableSupply({ state: "IN_USE", unitsTotal: 4, unitsRemaining: 1 }),
    ).toBe(true);
    expect(
      isAvailableSupply({ state: "EXPIRED", unitsTotal: 4, unitsRemaining: 4 }),
    ).toBe(false);
    expect(
      isAvailableSupply({ state: "USED_UP", unitsTotal: 4, unitsRemaining: 0 }),
    ).toBe(false);
    expect(
      isAvailableSupply({ state: "ACTIVE", unitsTotal: 4, unitsRemaining: 0 }),
    ).toBe(false);
  });
});

describe("supply surfaces — both detail-page readouts ride the shared helper (source guard)", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  it("the Übersicht supply row sums through summariseSupply and feeds the runway with the available-only figure", () => {
    const src = read(
      "src/components/medications/detail/MedicationDetailTabs.tsx",
    );
    expect(src).toContain('from "@/lib/medications/inventory/summary"');
    expect(src).toMatch(/summariseSupply\(inventoryItems, perDose\)/);
    expect(src).toMatch(
      /estimateRunwayDays\(dosesRemaining, medication\.schedules\)/,
    );
    // No hand-rolled "everything but USED_UP" filter remains.
    expect(src).not.toContain('state !== "USED_UP"');
    expect(src).toContain("medications.detail.bestand.expiredSuffix");
  });

  it("the Bestand summary sums through summariseSupply and surfaces the expired suffix", () => {
    const src = read(
      "src/components/medications/sections/inventory-section.tsx",
    );
    expect(src).toContain('from "@/lib/medications/inventory/summary"');
    // v1.18.3 (iOS#31) — the items are mapped through a nullable→0 coalesce
    // (an unknown-units row contributes nothing to the available headline)
    // before the shared helper, but the summary still rides summariseSupply.
    expect(src).toMatch(/summariseSupply\(\s*items\.map\(/);
    expect(src).not.toContain('state !== "USED_UP"');
    expect(src).toContain("medications.detail.bestand.expiredSuffix");
  });
});
