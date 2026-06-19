import { describe, expect, it } from "vitest";

import { promoteRecentTags, selectQuickTagKeys } from "../recent-tags";

describe("promoteRecentTags", () => {
  it("prepends a freshly-used key, most-recent first", () => {
    expect(promoteRecentTags(["a", "b"], ["c"])).toEqual(["c", "a", "b"]);
  });

  it("moves an already-present key to the front without duplicating", () => {
    expect(promoteRecentTags(["a", "b", "c"], ["b"])).toEqual(["b", "a", "c"]);
  });

  it("keeps the latest of a multi-key use at the front", () => {
    // The last key in `usedKeys` is the most recent → leads the list.
    expect(promoteRecentTags([], ["x", "y", "z"])).toEqual(["z", "y", "x"]);
  });

  it("de-duplicates within the used keys", () => {
    expect(promoteRecentTags(["a"], ["a", "a"])).toEqual(["a"]);
  });

  it("drops empty keys", () => {
    expect(promoteRecentTags(["a"], ["", "b"])).toEqual(["b", "a"]);
  });

  it("caps the history length", () => {
    const existing = Array.from({ length: 30 }, (_, i) => `k${i}`);
    const result = promoteRecentTags(existing, ["new"]);
    expect(result.length).toBe(24);
    expect(result[0]).toBe("new");
  });
});

describe("selectQuickTagKeys", () => {
  const catalog = ["a", "b", "c", "d", "e"];

  it("returns the MRU keys that still exist in the catalog", () => {
    expect(selectQuickTagKeys(["c", "a"], catalog, 3)).toEqual(["c", "a", "b"]);
  });

  it("drops MRU keys no longer in the catalog", () => {
    expect(selectQuickTagKeys(["gone", "b"], catalog, 2)).toEqual(["b", "a"]);
  });

  it("falls back to the first catalog keys with no history", () => {
    expect(selectQuickTagKeys([], catalog, 3)).toEqual(["a", "b", "c"]);
  });

  it("respects the limit", () => {
    expect(selectQuickTagKeys(["e", "d", "c"], catalog, 2)).toEqual(["e", "d"]);
  });

  it("never duplicates when topping up from the catalog", () => {
    const result = selectQuickTagKeys(["b"], catalog, 5);
    expect(new Set(result).size).toBe(result.length);
    expect(result[0]).toBe("b");
  });
});
