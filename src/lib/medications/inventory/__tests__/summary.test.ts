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
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

import { annotate } from "@/lib/logging/context";
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

describe("summariseSupply — central negative-stock sanity gate (#31)", () => {
  afterEach(() => {
    vi.mocked(annotate).mockClear();
  });

  it("RCA: an available row whose capacity is NaN (corrupt Decimal) would surface a NaN headline pre-fix — now clamped to 0 + annotated", () => {
    // The per-row availability predicate gates only on `unitsRemaining >
    // 0`, so a row with a real remaining but a corrupt / legacy
    // `unitsTotal` (a Decimal that deserialised to NaN) DOES pool in. The
    // pre-fix `reduce` then produced a NaN `unitsTotal` / `dosesTotal`
    // headline — the nonsensical Bestand the report described. The gate
    // floors it to 0 and fires the underflow event.
    const out = summariseSupply(
      [{ state: "IN_USE", unitsTotal: Number.NaN, unitsRemaining: 3 }],
      1,
    );
    expect(out.unitsRemaining).toBe(3);
    expect(out.unitsTotal).toBe(0);
    expect(out.dosesTotal).toBe(0);
    expect(annotate).toHaveBeenCalledWith({
      action: { name: "medication.inventory.underflow" },
      meta: {
        raw_units_remaining: 3,
        raw_units_total: null,
        clamped_units_remaining: 3,
        available_count: 1,
      },
    });
  });

  it("sanity gate: a corrupt remaining (NaN) on an EXPIRED-suffix path floors the expired figure too", () => {
    // The expired suffix is also pooled; a corrupt EXPIRED row must not
    // surface a NaN suffix. EXPIRED never reaches the available pool, so
    // no underflow event fires for it — but the expired figure floors.
    const out = summariseSupply(
      [{ state: "EXPIRED", unitsTotal: 4, unitsRemaining: Number.NaN }],
      1,
    );
    expect(out.expiredUnits).toBe(0);
    expect(out.unitsRemaining).toBe(0);
    expect(annotate).not.toHaveBeenCalled();
  });

  it("fix: a healthy mixed inventory yields the correct pooled figure and never annotates", () => {
    const out = summariseSupply(
      [
        { state: "IN_USE", unitsTotal: 4, unitsRemaining: 3 },
        { state: "ACTIVE", unitsTotal: 4, unitsRemaining: 4 },
      ],
      2,
    );
    expect(out).toEqual({
      unitsRemaining: 7,
      unitsTotal: 8,
      dosesRemaining: 3,
      dosesTotal: 4,
      expiredUnits: 0,
    });
    expect(annotate).not.toHaveBeenCalled();
  });
});

describe("supply surfaces — both detail-page readouts ride the shared helper (source guard)", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  it("the Übersicht supply row sums through summariseSupply and feeds the runway with the available-only figure", () => {
    const src = read(
      "src/components/medications/detail/medication-detail-tabs.tsx",
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
