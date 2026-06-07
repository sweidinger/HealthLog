import { describe, expect, it } from "vitest";

import {
  toggleId,
  toggleSelectAll,
  selectAllState,
  selectedIdsOnPage,
  selectedCountOnPage,
} from "../selection";

/**
 * v1.15.13 — pure page-scoped selection math for the measurements + mood
 * management lists. These helpers back the multi-select chrome; the tests
 * pin the set algebra so the select-all tri-state + the bulk-delete
 * payload stay correct without needing a DOM render.
 */
describe("data-list selection math", () => {
  describe("toggleId", () => {
    it("adds an id that is not present", () => {
      const next = toggleId(new Set(["a"]), "b");
      expect([...next].sort()).toEqual(["a", "b"]);
    });

    it("removes an id that is present", () => {
      const next = toggleId(new Set(["a", "b"]), "a");
      expect([...next]).toEqual(["b"]);
    });

    it("returns a new set (does not mutate the input)", () => {
      const input = new Set(["a"]);
      const next = toggleId(input, "b");
      expect(next).not.toBe(input);
      expect([...input]).toEqual(["a"]);
    });
  });

  describe("selectAllState", () => {
    it("is none on an empty page", () => {
      expect(selectAllState(new Set(["a"]), [])).toBe("none");
    });

    it("is none when nothing on the page is selected", () => {
      expect(selectAllState(new Set(["x"]), ["a", "b"])).toBe("none");
    });

    it("is some when at least one but not all are selected", () => {
      expect(selectAllState(new Set(["a"]), ["a", "b"])).toBe("some");
    });

    it("is all when every page id is selected", () => {
      expect(selectAllState(new Set(["a", "b"]), ["a", "b"])).toBe("all");
    });

    it("ignores selected ids that are not on the page", () => {
      // `x` is selected but off-page; the page is fully selected.
      expect(selectAllState(new Set(["a", "b", "x"]), ["a", "b"])).toBe("all");
    });
  });

  describe("toggleSelectAll", () => {
    it("adds every page id when not all are selected", () => {
      const next = toggleSelectAll(new Set(["a"]), ["a", "b", "c"]);
      expect([...next].sort()).toEqual(["a", "b", "c"]);
    });

    it("clears the page ids when all are already selected", () => {
      const next = toggleSelectAll(new Set(["a", "b"]), ["a", "b"]);
      expect([...next]).toEqual([]);
    });

    it("preserves off-page selection when clearing the page", () => {
      const next = toggleSelectAll(new Set(["a", "b", "x"]), ["a", "b"]);
      expect([...next]).toEqual(["x"]);
    });

    it("is a no-op on an empty page", () => {
      const next = toggleSelectAll(new Set(["a"]), []);
      expect([...next]).toEqual(["a"]);
    });
  });

  describe("selectedIdsOnPage / selectedCountOnPage", () => {
    it("returns only selected ids that are present on the page, in page order", () => {
      const selected = new Set(["c", "a", "x"]);
      const pageIds = ["a", "b", "c"];
      expect(selectedIdsOnPage(selected, pageIds)).toEqual(["a", "c"]);
      expect(selectedCountOnPage(selected, pageIds)).toBe(2);
    });

    it("never includes off-page ids in the bulk-delete payload", () => {
      const selected = new Set(["off-page-1", "off-page-2"]);
      const pageIds = ["a", "b"];
      expect(selectedIdsOnPage(selected, pageIds)).toEqual([]);
      expect(selectedCountOnPage(selected, pageIds)).toBe(0);
    });
  });
});
