/**
 * v1.16.10 — medications list presentation blob (resolver + serializer).
 *
 * The resolver must never throw on a stored row (malformed / legacy /
 * partial blobs collapse onto the defaults field-by-field); the
 * serializer dedupes and caps the manual order so the persisted blob
 * stays bounded and canonical.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MEDICATION_LIST_LAYOUT,
  MEDICATION_ORDER_MAX_ENTRIES,
  resolveMedicationListLayout,
  serializeMedicationListLayout,
} from "@/lib/medication-list-layout";

describe("resolveMedicationListLayout", () => {
  it("returns the defaults for a null / missing column", () => {
    expect(resolveMedicationListLayout(null)).toEqual(
      DEFAULT_MEDICATION_LIST_LAYOUT,
    );
    expect(resolveMedicationListLayout(undefined)).toEqual(
      DEFAULT_MEDICATION_LIST_LAYOUT,
    );
  });

  it("returns the defaults for a non-object blob", () => {
    expect(resolveMedicationListLayout("cards")).toEqual(
      DEFAULT_MEDICATION_LIST_LAYOUT,
    );
    expect(resolveMedicationListLayout(42)).toEqual(
      DEFAULT_MEDICATION_LIST_LAYOUT,
    );
  });

  it("resolves a complete stored blob verbatim", () => {
    expect(
      resolveMedicationListLayout({
        version: 1,
        view: "table",
        order: ["med-b", "med-a"],
      }),
    ).toEqual({ version: 1, view: "table", order: ["med-b", "med-a"] });
  });

  it("falls back per field: unknown view → cards, malformed order → empty", () => {
    expect(
      resolveMedicationListLayout({ view: "kanban", order: "med-a" }),
    ).toEqual({ version: 1, view: "cards", order: [] });
  });

  it("drops non-string and oversized order entries, keeping the rest", () => {
    const resolved = resolveMedicationListLayout({
      view: "table",
      order: ["med-a", 7, null, "x".repeat(65), "med-b"],
    });
    expect(resolved.order).toEqual(["med-a", "med-b"]);
  });

  it("dedupes a stored order (first occurrence wins)", () => {
    const resolved = resolveMedicationListLayout({
      view: "cards",
      order: ["med-a", "med-b", "med-a"],
    });
    expect(resolved.order).toEqual(["med-a", "med-b"]);
  });
});

describe("serializeMedicationListLayout", () => {
  it("emits the canonical v1 blob", () => {
    expect(
      serializeMedicationListLayout({ view: "table", order: ["med-a"] }),
    ).toEqual({ version: 1, view: "table", order: ["med-a"] });
  });

  it("dedupes the order before persisting", () => {
    expect(
      serializeMedicationListLayout({
        view: "cards",
        order: ["a", "b", "a", "c", "b"],
      }).order,
    ).toEqual(["a", "b", "c"]);
  });

  it("caps the order at the documented maximum", () => {
    const order = Array.from({ length: 500 }, (_, i) => `med-${i}`);
    expect(
      serializeMedicationListLayout({ view: "cards", order }).order.length,
    ).toBe(MEDICATION_ORDER_MAX_ENTRIES);
  });
});
